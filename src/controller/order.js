import Order from "../Model/order.js";
import User from "../Model/user.js";
import Vegetable from "../Model/vegetable.js";
import Basket from "../Model/basket.js";
import Coupon from "../Model/coupon.js";
import Address from "../Model/address.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";
import { incrementCouponUsage } from "./coupon.js";
import { processOrderInvoice, sendInvoiceEmail } from "./invoice.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import nodemailer from "nodemailer";
import "dotenv/config";
import { DELIVERY_CHARGES } from "../../const.js";
import Wallet from "../Model/wallet.model.js";
import WalletTransaction from "../Model/walletTransaction.model.js";
import { rupeeToPaise, generateReferenceId } from "../utility/walletHelpers.js";
import mongoose from "mongoose";
import {
  calculateCashback,
  isCashbackEligible,
} from "../../config/cashback.config.js";

// ================= CONSTANTS & CONFIGS =================
const CONFIG = Object.freeze({
  deliveryCharges: DELIVERY_CHARGES / 100,
  freeDeliveryThreshold: 269,
  orderIdRetries: 5,
  validStatuses: new Set([
    "placed",
    "processed",
    "shipped",
    "delivered",
    "cancelled",
  ]),
  weightToKg: new Map([
    ["1kg", 1],
    ["500g", 0.5],
    ["250g", 0.25],
    ["100g", 0.1],
  ]),
  weightPriceMap: new Map([
    ["1kg", "weight1kg"],
    ["500g", "weight500g"],
    ["250g", "weight250g"],
    ["100g", "weight100g"],
  ]),
  // ✅ NEW: Add validation limits
  maxOrderAmount: 100000, // ₹1 lakh max
  maxQuantity: 1000,
  maxItemsPerOrder: 50,
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// ✅ NEW: Input Sanitization Helper
const sanitizeString = (str) => {
  if (typeof str !== "string") return str;
  // Remove special regex characters to prevent NoSQL injection
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// ✅ NEW: Validate Numeric Input
const validateNumeric = (value, min = 0, max = CONFIG.maxOrderAmount) => {
  const num = Number(value);
  if (isNaN(num) || num < min || num > max) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return num;
};

// ================= ADMIN EMAIL NOTIFICATION =================
const sendAdminOrderNotification = async (order) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
    if (!adminEmail) {
      console.warn("Admin email not configured");
      return;
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const customerName = order.customerInfo?.name || "Unknown";

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background-color: #0e540b; color: white; padding: 15px; text-align: center;">
          <h2 style="margin: 0;">New Order</h2>
        </div>
        <div style="padding: 15px; background-color: #f8f9fa; border: 1px solid #ddd;">
          <p>Order #<strong>${order.orderId}</strong> placed</p>
          <p>Customer: ${customerName}</p>
          <p>Amount: ₹${(order.totalAmount || 0).toFixed(2)}</p>
        </div>
      </div>
    `;

    const mailOptions = {
      from: { name: "VegBazar Admin", address: process.env.EMAIL_USER },
      to: adminEmail,
      subject: `Order #${order.orderId} - ₹${(order.totalAmount || 0).toFixed(2)}`,
      html,
    };

    await transporter.sendMail(mailOptions);
  } catch (error) {
    // ✅ FIX: Don't expose internal details
    console.error(
      `Failed to send admin notification for order ${order.orderId}`,
    );
  }
};

// ================= LRU CACHE WITH DOUBLY LINKED LIST =================
class LRUCache {
  #capacity;
  #cache = new Map();

  constructor(capacity = 100) {
    this.#capacity = capacity;
  }

  get(key) {
    if (!this.#cache.has(key)) return null;
    const val = this.#cache.get(key);
    this.#cache.delete(key);
    this.#cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    } else if (this.#cache.size >= this.#capacity) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.set(key, value);
  }

  has(key) {
    return this.#cache.has(key);
  }
}

const orderIdCache = new LRUCache(100);

// ================= ORDER ID GENERATOR WITH EXPONENTIAL BACKOFF =================
const generateUniqueOrderId = async (retries = CONFIG.orderIdRetries) => {
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const cacheKey = `ORD${dateStr}`;

  if (orderIdCache.has(cacheKey)) {
    const newSeq = orderIdCache.get(cacheKey) + 1;
    orderIdCache.set(cacheKey, newSeq);
    return `${cacheKey}${String(newSeq).padStart(3, "0")}`;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const lastOrder = await Order.findOne(
        { orderId: { $regex: `^${cacheKey}` } },
        { orderId: 1 },
      )
        .sort({ orderId: -1 })
        .lean();

      const sequence = lastOrder
        ? parseInt(lastOrder.orderId.slice(-3)) + 1
        : 1;
      const orderId = `${cacheKey}${String(sequence).padStart(3, "0")}`;

      if (!(await Order.exists({ orderId }))) {
        orderIdCache.set(cacheKey, sequence);
        return orderId;
      }
    } catch (error) {
      // ✅ FIX: Better fallback - use timestamp + random
      if (i === retries - 1) {
        const timestamp = Date.now().toString().slice(-9);
        const random = Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, "0");
        return `ORD${timestamp}${random}`;
      }
      await new Promise((r) => setTimeout(r, 50 << i));
    }
  }
  throw new Error("Failed to generate order ID");
};

// ================= PRICE CALCULATION STRATEGY PATTERN =================
const priceStrategies = {
  set: (veg, setIdx, qty) => {
    const set = veg.setPricing?.sets?.[setIdx];
    if (!set) throw new Error(`Invalid set index: ${setIdx}`);
    return {
      type: "set",
      pricePerUnit: set.price,
      subtotal: set.price * qty,
      label: `${set.quantity} ${set.unit}`,
      setIndex: setIdx,
      setQuantity: set.quantity,
      setUnit: set.unit,
    };
  },
  weight: (veg, weight, qty) => {
    const price = veg.prices?.[CONFIG.weightPriceMap.get(weight)];
    if (!price) throw new Error(`Invalid weight: ${weight}`);
    return {
      type: "weight",
      pricePerUnit: price,
      subtotal: price * qty,
      weight,
    };
  },
};

const getPrice = (veg, weightOrSet, qty = 1) => {
  const isSet = veg.pricingType === "set" || veg.setPricing?.enabled;
  const setIdx = weightOrSet.startsWith("set")
    ? parseInt(weightOrSet.slice(3))
    : parseInt(weightOrSet);
  return isSet
    ? priceStrategies.set(veg, setIdx, qty)
    : priceStrategies.weight(veg, weightOrSet, qty);
};

// ================= BULK STOCK UPDATE (SINGLE DB CALL) =================
const updateStock = async (items, operation = "deduct") => {
  const vegIds = [...new Set(items.map((i) => i.vegetable))];
  const vegetables = await Vegetable.find({ _id: { $in: vegIds } }).lean();
  const vegMap = new Map(vegetables.map((v) => [v._id.toString(), v]));

  const ops = [];
  const updates = [];

  for (const item of items) {
    const veg = vegMap.get(item.vegetable.toString());
    if (!veg) throw new Error(`Vegetable not found: ${item.vegetable}`);

    const isSet = veg.pricingType === "set" || veg.setPricing?.enabled;
    const setIdx = item.setIndex ?? parseInt(item.weight?.slice(3) || "0");

    if (isSet) {
      const pieces = veg.setPricing.sets[setIdx].quantity * item.quantity;
      const delta = operation === "deduct" ? -pieces : pieces;
      if (operation === "deduct" && veg.stockPieces < pieces) {
        throw new Error(`Insufficient stock for ${veg.name}`);
      }
      ops.push({
        updateOne: {
          filter: { _id: item.vegetable },
          update: {
            $inc: { stockPieces: delta },
            $set: { outOfStock: veg.stockPieces + delta <= 0 },
          },
        },
      });
      updates.push({
        vegetableId: item.vegetable,
        vegetableName: veg.name,
        [operation === "deduct" ? "deducted" : "restored"]: pieces,
        previousStock: veg.stockPieces,
        type: "pieces",
      });
    } else {
      const kg = CONFIG.weightToKg.get(item.weight) * item.quantity;
      const delta = operation === "deduct" ? -kg : kg;
      if (operation === "deduct" && veg.stockKg < kg) {
        throw new Error(`Insufficient stock for ${veg.name}`);
      }
      ops.push({
        updateOne: {
          filter: { _id: item.vegetable },
          update: {
            $inc: { stockKg: delta },
            $set: { outOfStock: veg.stockKg + delta < 0.25 },
          },
        },
      });
      updates.push({
        vegetableId: item.vegetable,
        vegetableName: veg.name,
        [operation === "deduct" ? "deducted" : "restored"]: kg,
        previousStock: veg.stockKg,
        type: "kg",
      });
    }
  }

  if (ops.length) await Vegetable.bulkWrite(ops);
  return updates;
};

// ================= CUSTOMER PROCESSING WITH UPSERT =================
const processCustomer = async (info) => {
  if (typeof info === "string") {
    if (!(await User.exists({ _id: info }))) throw new Error("User not found");
    return info;
  }
  if (info._id) return info._id;

  const phone = info.phone || info.mobile;
  if (!phone) throw new Error("Phone required");

  try {
    let user = await User.findOne({ phone });

    if (!user) {
      user = await User.create({
        ...(info.name && { username: info.name }),
        ...(info.email && { email: info.email }),
        phone,
        isApproved: true,
        role: "user",
      });
    } else {
      Object.assign(user, {
        ...(info.name && { username: info.name }),
        ...(info.email && { email: info.email }),
      });
      await user.save();
    }

    if (info.address || info.city || info.area) {
      const existingAddresses = await Address.find({ user: user._id });
      const addressData = {
        street: info.address || "N/A",
        area: info.area || "N/A",
        city: info.city || "N/A",
        state: info.state || "Gujarat",
        pincode: info.zipCode || info.pincode || "000000",
        country: "India",
        type: info.addressType || "home",
        isDefault: existingAddresses.length === 0,
      };

      const similarAddress = existingAddresses.find(
        (addr) =>
          addr.street === addressData.street &&
          addr.city === addressData.city &&
          addr.area === addressData.area,
      );

      if (!similarAddress) {
        await user.addAddress(addressData);
      } else if (existingAddresses.length === 1) {
        await user.setDefaultAddress(similarAddress._id);
      }
    }

    return user._id;
  } catch (err) {
    if (err.code === 11000 && info.email) {
      const user = await User.findOne({ email: info.email });
      if (user) return user._id;
    }
    throw err;
  }
};

// ================= VEGETABLE PROCESSING WITH GROUPING =================
const getVegId = (item) => {
  if (!item) return null;
  if (typeof item === "string") return item;
  if (item instanceof mongoose.Types.ObjectId) return item.toString();

  if (item.vegetable) {
    if (typeof item.vegetable === "string") return item.vegetable;
    if (item.vegetable instanceof mongoose.Types.ObjectId)
      return item.vegetable.toString();
    return item.vegetable._id || item.vegetable.id;
  }
  return item._id || item.id || item.name;
};

const processVegetables = async (items, isBasket = false) => {
  if (!Array.isArray(items) || !items.length) throw new Error("Items required");

  // ✅ FIX: Validate max items
  if (items.length > CONFIG.maxItemsPerOrder) {
    throw new Error(
      `Maximum ${CONFIG.maxItemsPerOrder} items allowed per order`,
    );
  }

  const vegIds = [...new Set(items.map(getVegId).filter(Boolean))];
  if (!vegIds.length) throw new Error("No valid items");

  const isObjectId = /^[0-9a-fA-F]{24}$/.test(vegIds[0]);
  const vegetables = await Vegetable.find(
    isObjectId
      ? { _id: { $in: vegIds } }
      : { $or: [{ name: { $in: vegIds } }, { _id: { $in: vegIds } }] },
  ).lean();

  if (vegetables.length !== vegIds.length) {
    throw new Error(`Missing vegetables: ${vegIds.length - vegetables.length}`);
  }

  const vegMap = new Map();
  vegetables.forEach((v) => {
    vegMap.set(v._id.toString(), v);
    vegMap.set(v.name, v);
  });

  const grouped = new Map();
  items.forEach((item) => {
    const veg =
      vegMap.get(getVegId(item).toString()) || vegMap.get(getVegId(item));
    if (!veg) throw new Error(`Vegetable not found: ${getVegId(item)}`);

    const weight = item.weight || "1kg";
    const qty = item.quantity || 1;

    // ✅ FIX: Validate quantity
    if (qty < 1 || qty > CONFIG.maxQuantity) {
      throw new Error(`Invalid quantity for ${veg.name}: ${qty}`);
    }

    const key = `${veg._id}_${weight}`;

    if (grouped.has(key)) {
      const existing = grouped.get(key);
      existing.quantity += qty;
      existing.subtotal = existing.pricePerUnit * existing.quantity;
    } else {
      const priceInfo = getPrice(veg, weight, qty);
      grouped.set(key, {
        vegetable: veg._id,
        quantity: qty,
        pricePerUnit: priceInfo.pricePerUnit,
        subtotal: priceInfo.subtotal,
        isFromBasket: isBasket,
        ...(priceInfo.type === "set"
          ? {
              weight,
              setIndex: priceInfo.setIndex,
              setLabel: priceInfo.label,
              setQuantity: priceInfo.setQuantity,
              setUnit: priceInfo.setUnit,
            }
          : { weight: priceInfo.weight }),
      });
    }
  });
  return Array.from(grouped.values());
};

// ================= PARALLEL ORDER DATA PROCESSING =================
const processOrderData = async (
  customer,
  basket,
  vegetables,
  type = "custom",
) => {
  try {
    const [customerId, basketId, processedVegs] = await Promise.all([
      processCustomer(customer),
      type === "basket" && basket
        ? Basket.findById(typeof basket === "string" ? basket : basket._id, {
            _id: 1,
          })
            .lean()
            .then((b) => {
              if (!b) throw new Error("Basket not found");
              return b._id;
            })
        : null,
      processVegetables(vegetables, type === "basket"),
    ]);
    return { customerId, basketId, processedVegetables: processedVegs };
  } catch (error) {
    return { error: error.message };
  }
};

// ================= CASHBACK MANAGEMENT =================
async function creditCashbackToWallet(order) {
  try {
    if (
      !order.cashbackEligible ||
      order.cashbackCredited ||
      order.cashbackAmount <= 0
    ) {
      return { success: false, reason: "Not eligible or already credited" };
    }

    const customerId = order.customerInfo;
    let wallet = await Wallet.findByUserId(customerId);

    if (!wallet) {
      wallet = await Wallet.createWallet(customerId);
    }

    if (!wallet.isActive()) {
      return { success: false, reason: "Wallet inactive" };
    }

    const transaction = await WalletTransaction.createCreditTransaction(
      wallet._id,
      "cashback",
      `CSHBK-${order.orderId}`,
      Math.round(order.cashbackAmount * 100),
      `Cashback for order ${order.orderId}`,
    );

    await Order.findByIdAndUpdate(order._id, {
      cashbackCredited: true,
      cashbackCreditedAt: new Date(),
    });

    return {
      success: true,
      amount: order.cashbackAmount,
      transaction: transaction[0],
    };
  } catch (error) {
    console.error("Cashback credit failed");
    return { success: false, error: error.message };
  }
}

// ================= ORDER CREATION =================
const calculateOrderTotal = (
  vegs,
  basketPrice = null,
  type = "custom",
  discount = 0,
) => {
  const vegTotal = vegs.reduce((sum, i) => sum + i.subtotal, 0);

  if (type === "basket") {
    if (!basketPrice) throw new Error("Basket price required");
    const afterDiscount = Math.max(0, basketPrice - discount);
    return {
      vegetablesTotal: vegTotal,
      basketPrice,
      couponDiscount: discount,
      subtotalAfterDiscount: afterDiscount,
      deliveryCharges: CONFIG.deliveryCharges,
      totalAmount: afterDiscount + CONFIG.deliveryCharges,
    };
  }

  const afterDiscount = Math.max(0, vegTotal - discount);
  const delivery =
    afterDiscount > CONFIG.freeDeliveryThreshold ? 0 : CONFIG.deliveryCharges;

  return {
    vegetablesTotal: vegTotal,
    basketPrice: 0,
    couponDiscount: discount,
    subtotalAfterDiscount: afterDiscount,
    deliveryCharges: delivery,
    totalAmount: afterDiscount + delivery,
  };
};

// ================= COUPON VALIDATION =================
const validateCoupon = async (code, subtotal, userId = null) => {
  if (!code) {
    return {
      couponId: null,
      couponDiscount: 0,
      validatedCouponCode: null,
      couponDetails: null,
    };
  }

  const coupon = await Coupon.findOne({
    code: code.toUpperCase(),
    isActive: true,
  }).lean();

  if (!coupon) throw new Error("Invalid coupon");
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date())
    throw new Error("Coupon expired");
  if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount) {
    throw new Error(`Minimum ₹${coupon.minOrderAmount} required`);
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit)
    throw new Error("Coupon limit reached");
  if (userId && coupon.perUserLimit) {
    const userUsage =
      coupon.usedBy?.filter((id) => id.toString() === userId.toString())
        .length || 0;
    if (userUsage >= coupon.perUserLimit) throw new Error("User limit reached");
  }

  const discount =
    coupon.discountType === "percentage"
      ? Math.min(
          (subtotal * coupon.discountValue) / 100,
          coupon.maxDiscount || Infinity,
        )
      : Math.min(coupon.discountValue, subtotal);

  return {
    couponId: coupon._id,
    couponDiscount: discount,
    validatedCouponCode: coupon.code,
    couponDetails: {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount,
    },
  };
};

// ✅ FIX: Clean order data before creation
const cleanOrderData = (data) => {
  const cleaned = { ...data };

  // Remove undefined values
  Object.keys(cleaned).forEach((key) => {
    if (cleaned[key] === undefined) {
      delete cleaned[key];
    }
  });

  // ✅ CRITICAL FIX: Remove stockUpdates - it should NOT be stored
  delete cleaned.stockUpdates;

  // ✅ FIX: Ensure required fields have proper defaults
  cleaned.walletCreditUsed = cleaned.walletCreditUsed || 0;
  cleaned.cashbackAmount = cleaned.cashbackAmount || 0;
  cleaned.cashbackEligible = cleaned.cashbackEligible || false;
  cleaned.couponCode = cleaned.couponCode || null;
  cleaned.couponId = cleaned.couponId || null;
  cleaned.deliveryAddressId = cleaned.deliveryAddressId || null;

  // ✅ FIX: Ensure finalPayableAmount is set
  if (
    cleaned.finalPayableAmount === undefined ||
    cleaned.finalPayableAmount === null
  ) {
    cleaned.finalPayableAmount = Math.max(
      0,
      cleaned.totalAmount - (cleaned.walletCreditUsed || 0),
    );
  }

  return cleaned;
};

// ================= ORDER CREATION WITH RETRY =================
const createOrderWithRetry = async (
  data,
  maxRetries = CONFIG.orderIdRetries,
) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const orderId = data.orderId || (await generateUniqueOrderId());

      // ✅ FIX: Clean data before creating order
      const cleanedData = cleanOrderData({ ...data, orderId });

      const order = await Order.create(cleanedData);
      return { order, orderId };
    } catch (err) {
      if (err.code === 11000 && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 50 << i));
        continue;
      }

      // ✅ FIX: Don't expose internal error details
      console.error("Order creation failed:", err.name, err.code);

      // Log full details for MongoDB validation errors (code 121)
      if (err.code === 121 && err.errInfo) {
        console.error(
          "MongoDB $jsonSchema validation details:",
          JSON.stringify(err.errInfo, null, 2),
        );
      }

      // Return user-friendly error
      if (err.name === "ValidationError") {
        throw new Error(
          "Order validation failed. Please check your order details.",
        );
      } else if (err.code === 11000) {
        throw new Error("Duplicate order detected. Please try again.");
      } else if (err.code === 121) {
        throw new Error(
          "Order validation failed. Please try again or contact support.",
        );
      } else {
        throw new Error("Failed to create order. Please try again.");
      }
    }
  }
  throw new Error("Failed to create order after multiple attempts");
};

// ================= CONTROLLERS =================
export const calculateTodayOrderTotal = asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const count = await Order.countDocuments({
    createdAt: { $gte: today, $lt: tomorrow },
  });
  res.json(new ApiResponse(200, { count }, "Today's order count fetched"));
});

export const getOrders = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit)));
  const skip = (page - 1) * limit;

  const filter = {};

  // ✅ FIX: Sanitize inputs to prevent NoSQL injection
  if (req.query.status) {
    const sanitized = sanitizeString(req.query.status);
    filter.paymentStatus = sanitized;
  }
  if (req.query.paymentMethod) {
    const sanitized = sanitizeString(req.query.paymentMethod);
    filter.paymentMethod = sanitized;
  }
  if (req.query.orderType) {
    const sanitized = sanitizeString(req.query.orderType);
    filter.orderType = sanitized;
  }

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("customerInfo")
      .populate("deliveryAddressId")
      .populate({
        path: "selectedBasket",
        populate: { path: "vegetables.vegetable", select: "name" },
      })
      .populate("selectedVegetables.vegetable")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        orders,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalOrders: total,
          hasMore: page * limit < total,
        },
      },
      "Orders fetched",
    ),
  );
});

export const getOrderById = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  if (!/^ORD\d{11,12}$/.test(orderId)) {
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));
  }

  const order = await Order.findOne({ orderId })
    .populate("customerInfo")
    .populate({ path: "deliveryAddress", populate: { path: "user" } })
    .populate({
      path: "selectedBasket",
      populate: { path: "vegetables.vegetable", select: "name" },
    })
    .populate("selectedVegetables.vegetable")
    .lean();

  if (!order)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  res.json(new ApiResponse(200, order, "Order fetched"));
});

export const addOrder = asyncHandler(async (req, res) => {
  const {
    customerInfo,
    selectedBasket,
    selectedVegetables,
    paymentMethod,
    orderType,
    couponCode,
    deliveryAddressId,
  } = req.body;

  // ✅ FIX: Enhanced validation
  if (!customerInfo)
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Customer info required"));
  if (!["basket", "custom"].includes(orderType))
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid order type"));
  if (orderType === "basket" && !selectedBasket)
    return res.status(400).json(new ApiResponse(400, null, "Basket required"));
  if (!Array.isArray(selectedVegetables) || !selectedVegetables.length) {
    return res.status(400).json(new ApiResponse(400, null, "Items required"));
  }
  if (!["COD", "ONLINE", "WALLET"].includes(paymentMethod))
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid payment method"));

  const processed = await processOrderData(
    customerInfo,
    selectedBasket,
    selectedVegetables,
    orderType,
  );

  if (processed.error)
    return res.status(400).json(new ApiResponse(400, null, processed.error));

  const { customerId, basketId, processedVegetables } = processed;

  let subtotal =
    orderType === "basket"
      ? (await Basket.findById(basketId, { price: 1 }).lean()).price
      : processedVegetables.reduce((sum, i) => sum + i.subtotal, 0);

  // ✅ FIX: Validate subtotal
  if (subtotal <= 0 || subtotal > CONFIG.maxOrderAmount) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid order amount"));
  }

  let couponId = null,
    couponDiscount = 0,
    validatedCode = null;
  if (couponCode) {
    try {
      const v = await validateCoupon(couponCode, subtotal, customerId);
      couponId = v.couponId;
      couponDiscount = v.couponDiscount;
      validatedCode = v.validatedCouponCode;
    } catch (err) {
      return res.status(400).json(new ApiResponse(400, null, err.message));
    }
  }

  const totals = calculateOrderTotal(
    processedVegetables,
    orderType === "basket"
      ? (await Basket.findById(basketId, { price: 1 }).lean()).price
      : null,
    orderType,
    couponDiscount,
  );

  let walletCreditUsed = 0;
  let finalPayableAmount = totals.totalAmount;

  try {
    const wallet = await Wallet.findByUserId(customerId);

    if (wallet && wallet.isActive()) {
      const walletBalance = await WalletTransaction.getCurrentBalance(
        wallet._id,
      );
      const walletBalanceInRupees = walletBalance / 100;
      walletCreditUsed = Math.min(walletBalanceInRupees, totals.totalAmount);
      finalPayableAmount = Math.max(0, totals.totalAmount - walletCreditUsed);
    }
  } catch (error) {
    // Continue without wallet credit
  }

  // ================= COD PAYMENT FLOW =================
  if (paymentMethod === "COD") {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Update stock
      const stockUpdates = await updateStock(processedVegetables, "deduct");
      const orderId = await generateUniqueOrderId();

      const completedOrderCount = await Order.countDocuments({
        customerInfo: customerId,
        orderStatus: { $in: ["placed", "processed", "shipped", "delivered"] },
      });

      const orderForCashback = {
        finalPayableAmount,
        totalAmount: totals.totalAmount,
        paymentMethod: "COD",
      };
      const cashbackAmount = calculateCashback(
        orderForCashback,
        customerId,
        completedOrderCount,
      );
      const cashbackEligible = cashbackAmount > 0;

      // 2. Create order (stockUpdates will be removed by cleanOrderData)
      const result = await createOrderWithRetry({
        orderId,
        orderType,
        customerInfo: customerId,
        selectedVegetables: processedVegetables,
        orderDate: new Date(),
        couponCode: validatedCode,
        couponId,
        ...totals,
        walletCreditUsed,
        finalPayableAmount,
        cashbackEligible,
        cashbackAmount,
        paymentMethod: "COD",
        paymentStatus: finalPayableAmount === 0 ? "completed" : "pending",
        orderStatus: "placed",
        deliveryAddressId,
        ...(orderType === "basket" && { selectedBasket: basketId }),
      });

      // 3. Debit wallet if needed
      if (walletCreditUsed > 0) {
        const wallet = await Wallet.findByUserId(customerId);
        const amountInPaise = rupeeToPaise(walletCreditUsed);

        await WalletTransaction.createDebitTransaction(
          wallet._id,
          "order_payment",
          result.orderId,
          amountInPaise,
          `Wallet credit applied to order ${result.orderId}`,
        );
      }

      // 4. Increment coupon usage
      if (couponId) await incrementCouponUsage(couponId, customerId);

      // 5. Update user orders
      await User.findByIdAndUpdate(customerId, {
        $push: { orders: result.order._id },
      });

      await session.commitTransaction();
      session.endSession();

      // 6. Credit cashback (async - don't wait)
      if (cashbackEligible && cashbackAmount > 0) {
        creditCashbackToWallet(result.order).catch(() => {});
      }

      // 7. Populate and return
      const populated = await Order.findById(result.order._id)
        .populate("customerInfo", "name email phone")
        .populate("deliveryAddressId")
        .populate({
          path: "selectedBasket",
          populate: { path: "vegetables.vegetable", select: "name" },
        })
        .populate("selectedVegetables.vegetable", "name")
        .lean();

      // 8. Send notifications (async)
      processOrderInvoice(populated._id, {
        sendEmail: true,
        emailType: "invoice",
      }).catch(() => {});
      sendAdminOrderNotification(populated).catch(() => {});

      return res.json(new ApiResponse(201, populated, "Order placed with COD"));
    } catch (err) {
      await session.abortTransaction();
      session.endSession();

      // Restore stock
      try {
        await updateStock(processedVegetables, "restore");
      } catch (restoreErr) {}

      return res.status(500).json(new ApiResponse(500, null, err.message));
    }
  }

  // ================= WALLET PAYMENT FLOW =================
  if (paymentMethod === "WALLET") {
    if (finalPayableAmount > 0) {
      return res.status(400).json(
        new ApiResponse(
          400,
          {
            totalAmount: totals.totalAmount,
            walletBalance: walletCreditUsed,
            shortfall: finalPayableAmount,
          },
          "Insufficient wallet balance",
        ),
      );
    }

    const wallet = await Wallet.findByUserId(customerId);

    if (!wallet) {
      return res
        .status(404)
        .json(new ApiResponse(404, null, "Wallet not found"));
    }

    if (!wallet.isActive()) {
      return res
        .status(400)
        .json(new ApiResponse(400, null, "Wallet inactive"));
    }

    const currentBalance = await WalletTransaction.getCurrentBalance(
      wallet._id,
    );
    const amountInPaise = rupeeToPaise(totals.totalAmount);

    if (currentBalance < amountInPaise) {
      return res.status(400).json(
        new ApiResponse(
          400,
          {
            required: totals.totalAmount,
            available: currentBalance / 100,
            shortfall: (amountInPaise - currentBalance) / 100,
          },
          "Insufficient wallet balance",
        ),
      );
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Update stock
      await updateStock(processedVegetables, "deduct");

      // 2. Create order
      const orderId = await generateUniqueOrderId();
      const completedOrderCount = await Order.countDocuments({
        customerInfo: customerId,
        orderStatus: { $in: ["placed", "processed", "shipped", "delivered"] },
      });

      const orderForCashback = {
        finalPayableAmount: 0,
        totalAmount: totals.totalAmount,
        paymentMethod: "WALLET",
      };
      const cashbackAmount = calculateCashback(
        orderForCashback,
        customerId,
        completedOrderCount,
      );
      const cashbackEligible = cashbackAmount > 0;

      const result = await createOrderWithRetry({
        orderId,
        orderType,
        customerInfo: customerId,
        selectedVegetables: processedVegetables,
        orderDate: new Date(),
        couponCode: validatedCode,
        couponId,
        ...totals,
        walletCreditUsed: totals.totalAmount,
        finalPayableAmount: 0,
        cashbackEligible,
        cashbackAmount,
        paymentMethod: "WALLET",
        paymentStatus: "completed",
        orderStatus: "placed",
        deliveryAddressId,
        ...(orderType === "basket" && { selectedBasket: basketId }),
      });

      // 3. Debit wallet
      await WalletTransaction.createDebitTransaction(
        wallet._id,
        "order_payment",
        result.orderId,
        amountInPaise,
        `Payment for order ${result.orderId}`,
        session,
      );

      // 4. Update coupon and user
      if (couponId) {
        await incrementCouponUsage(couponId, customerId);
      }

      await User.findByIdAndUpdate(customerId, {
        $push: { orders: result.order._id },
      });

      await session.commitTransaction();
      session.endSession();

      const populated = await Order.findById(result.order._id)
        .populate("customerInfo", "name email phone")
        .populate("deliveryAddressId")
        .populate({
          path: "selectedBasket",
          populate: { path: "vegetables.vegetable", select: "name" },
        })
        .populate("selectedVegetables.vegetable", "name")
        .lean();

      return res.json(
        new ApiResponse(
          201,
          {
            ...populated,
            walletDebit: {
              amount: totals.totalAmount,
              previousBalance: currentBalance / 100,
              newBalance: (currentBalance - amountInPaise) / 100,
            },
          },
          "Order placed with wallet",
        ),
      );
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      try {
        await updateStock(processedVegetables, "restore");
      } catch (restoreErr) {}

      return res.status(500).json(new ApiResponse(500, null, error.message));
    }
  }

  // ================= ONLINE PAYMENT FLOW (RAZORPAY) =================
  const orderId = await generateUniqueOrderId();
  const razorpayOrder = await razorpay.orders.create({
    amount: Math.round(finalPayableAmount * 100),
    currency: "INR",
    receipt: orderId,
    payment_capture: 1,
  });

  const completedOrderCount = await Order.countDocuments({
    customerInfo: customerId,
    orderStatus: { $in: ["placed", "processed", "shipped", "delivered"] },
  });

  const orderForCashback = {
    finalPayableAmount,
    totalAmount: totals.totalAmount,
    paymentMethod: "ONLINE",
  };
  const cashbackAmount = calculateCashback(
    orderForCashback,
    customerId,
    completedOrderCount,
  );
  const cashbackEligible = cashbackAmount > 0;

  res.json(
    new ApiResponse(
      201,
      {
        razorpayOrder,
        walletInfo: {
          walletCreditUsed,
          originalAmount: totals.totalAmount,
          finalPayableAmount,
        },
        orderData: {
          orderType,
          customerInfo: customerId,
          selectedVegetables: processedVegetables,
          orderId,
          couponCode: validatedCode,
          couponId,
          ...totals,
          walletCreditUsed,
          finalPayableAmount,
          cashbackEligible,
          cashbackAmount,
          deliveryAddressId,
          ...(orderType === "basket" && { selectedBasket: basketId }),
        },
      },
      "Razorpay order created",
    ),
  );
});

// ================= VERIFY PAYMENT CONTROLLER =================
export const verifyPayment = asyncHandler(async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    customerInfo,
    selectedBasket,
    selectedVegetables,
    orderId,
    orderType,
    couponCode,
    deliveryAddressId,
  } = req.body;

  // Validation
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing payment data"));
  }
  if (!customerInfo || !selectedVegetables || !orderId) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing order data"));
  }
  if (orderType === "basket" && !selectedBasket) {
    return res.status(400).json(new ApiResponse(400, null, "Missing basket"));
  }

  // Verify signature
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSig !== razorpay_signature) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid signature"));
  }

  // Check duplicate
  if (await Order.exists({ razorpayPaymentId: razorpay_payment_id })) {
    return res.status(400).json(new ApiResponse(400, null, "Order exists"));
  }

  const processed = await processOrderData(
    customerInfo,
    selectedBasket,
    selectedVegetables,
    orderType,
  );

  if (processed.error) {
    return res.status(400).json(new ApiResponse(400, null, processed.error));
  }

  const { customerId, basketId, processedVegetables } = processed;

  let subtotal =
    orderType === "basket"
      ? (await Basket.findById(basketId, { price: 1 }).lean()).price
      : processedVegetables.reduce((sum, i) => sum + i.subtotal, 0);

  let couponId = null,
    couponDiscount = 0,
    validatedCode = null;
  if (couponCode) {
    try {
      const v = await validateCoupon(couponCode, subtotal, customerId);
      couponId = v.couponId;
      couponDiscount = v.couponDiscount;
      validatedCode = v.validatedCouponCode;
    } catch (err) {
      // Continue without coupon
    }
  }

  const totals = calculateOrderTotal(
    processedVegetables,
    orderType === "basket"
      ? (await Basket.findById(basketId, { price: 1 }).lean()).price
      : null,
    orderType,
    couponDiscount,
  );

  let walletCreditUsed = 0;
  let finalPayableAmount = totals.totalAmount;

  try {
    const wallet = await Wallet.findByUserId(customerId);

    if (wallet && wallet.isActive()) {
      const walletBalance = await WalletTransaction.getCurrentBalance(
        wallet._id,
      );
      const walletBalanceInRupees = walletBalance / 100;
      walletCreditUsed = Math.min(walletBalanceInRupees, totals.totalAmount);
      finalPayableAmount = Math.max(0, totals.totalAmount - walletCreditUsed);
    }
  } catch (error) {
    // Continue
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Update stock
    await updateStock(processedVegetables, "deduct");

    // 2. Create order
    const completedOrderCount = await Order.countDocuments({
      customerInfo: customerId,
      orderStatus: { $in: ["placed", "processed", "shipped", "delivered"] },
    });

    const orderForCashback = {
      finalPayableAmount,
      totalAmount: totals.totalAmount,
      paymentMethod: "ONLINE",
    };
    const cashbackAmount = calculateCashback(
      orderForCashback,
      customerId,
      completedOrderCount,
    );
    const cashbackEligible = cashbackAmount > 0;

    const result = await createOrderWithRetry({
      orderId,
      orderType,
      customerInfo: customerId,
      selectedVegetables: processedVegetables,
      orderDate: new Date(),
      couponCode: validatedCode,
      couponId,
      ...totals,
      walletCreditUsed,
      finalPayableAmount,
      cashbackEligible,
      cashbackAmount,
      paymentMethod: "ONLINE",
      orderStatus: "placed",
      paymentStatus: "completed",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      deliveryAddressId,
      ...(orderType === "basket" && { selectedBasket: basketId }),
    });

    // 3. Debit wallet if needed
    if (walletCreditUsed > 0) {
      const wallet = await Wallet.findByUserId(customerId);
      const amountInPaise = rupeeToPaise(walletCreditUsed);

      await WalletTransaction.createDebitTransaction(
        wallet._id,
        "order_payment",
        result.orderId,
        amountInPaise,
        `Wallet credit applied to order ${result.orderId}`,
      );
    }

    // 4. Update coupon and user
    if (couponId) {
      await incrementCouponUsage(couponId, customerId);
    }

    await User.findByIdAndUpdate(customerId, {
      $push: { orders: result.order._id },
    });

    await session.commitTransaction();
    session.endSession();

    // 5. Credit cashback (async)
    if (cashbackEligible && cashbackAmount > 0) {
      creditCashbackToWallet(result.order).catch(() => {});
    }

    // 6. Populate
    const populated = await Order.findById(result.order._id)
      .populate("customerInfo", "name email phone")
      .populate("deliveryAddressId")
      .populate({
        path: "selectedBasket",
        populate: { path: "vegetables.vegetable", select: "name" },
      })
      .populate("selectedVegetables.vegetable", "name")
      .lean();

    // 7. Send notifications (async)
    processOrderInvoice(populated._id, {
      sendEmail: true,
      emailType: "invoice",
    }).catch(() => {});
    sendAdminOrderNotification(populated).catch(() => {});

    res.json(new ApiResponse(200, populated, "Payment verified"));
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    try {
      await updateStock(processedVegetables, "restore");
    } catch (restoreErr) {}

    return res.status(500).json(new ApiResponse(500, null, err.message));
  }
});

export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { orderStatus } = req.body;

  // ✅ FIX: Sanitize input
  const sanitizedStatus = sanitizeString(orderStatus);

  if (!CONFIG.validStatuses.has(sanitizedStatus)) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          `Invalid status. Use: ${[...CONFIG.validStatuses].join(", ")}`,
        ),
      );
  }

  const current = await Order.findById(_id, {
    orderStatus: 1,
    selectedVegetables: 1,
  }).lean();

  if (!current)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));

  if (sanitizedStatus === "cancelled" && current.orderStatus !== "cancelled") {
    try {
      await updateStock(current.selectedVegetables, "restore");
    } catch (err) {
      console.error("Stock restore error");
    }
  }

  const updateFields = { orderStatus: sanitizedStatus };
  if (sanitizedStatus.toLowerCase() === "delivered") {
    updateFields.paymentStatus = "completed";
  }

  const order = await Order.findByIdAndUpdate(_id, updateFields, {
    new: true,
    runValidators: true,
  })
    .populate("customerInfo", "name email mobile phone address city area state")
    .populate({
      path: "selectedBasket",
      populate: { path: "vegetables.vegetable", select: "name" },
    })
    .populate("selectedVegetables.vegetable", "name")
    .lean();

  if (order?.customerInfo?.email) {
    const message = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #0e540b; color: white; padding: 20px; text-align: center;">
          <h1>VegBazar</h1>
        </div>
        <div style="padding: 20px; background-color: #f8f9fa;">
          <h2 style="color: #0e540b;">Order Status Updated</h2>
          <p>Dear ${order.customerInfo.name || "Customer"},</p>
          <p>Your order <strong>#${order.orderId}</strong> status has been updated to:</p>
          <h3 style="color: #e57512; text-transform: uppercase; margin: 20px 0;">${sanitizedStatus}</h3>
          <p>Track your order or view details in your account.</p>
          <p>Thank you for shopping with VegBazar!</p>
        </div>
        <div style="background-color: #0e540b; color: white; padding: 15px; text-align: center; font-size: 12px;">
          <p>Need help? Contact us at info.vegbazar@gmail.com</p>
        </div>
      </div>
    `;

    sendInvoiceEmail(order, null, {
      customSubject: `Order Status Update - #${order.orderId}`,
      customMessage: message,
      emailType: "statusUpdate",
    }).catch(() => {});
  }

  res.json(new ApiResponse(200, order, "Order status updated"));
});

export const getRazorpayKey = asyncHandler(async (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID) {
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Key not configured"));
  }
  res.json(
    new ApiResponse(200, { key: process.env.RAZORPAY_KEY_ID }, "Key fetched"),
  );
});

export const calculatePrice = asyncHandler(async (req, res) => {
  const { items, couponCode } = req.body;
  if (!items || !Array.isArray(items) || !items.length)
    throw new ApiError(400, "Items required");

  // ✅ FIX: Validate item count
  if (items.length > CONFIG.maxItemsPerOrder) {
    throw new ApiError(400, `Maximum ${CONFIG.maxItemsPerOrder} items allowed`);
  }

  let subtotal = 0;
  const calculatedItems = [];

  for (const item of items) {
    if (
      !item.vegetableId ||
      !item.weight ||
      !item.quantity ||
      item.quantity < 1
    ) {
      throw new ApiError(400, "Invalid item");
    }

    // ✅ FIX: Validate quantity
    if (item.quantity > CONFIG.maxQuantity) {
      throw new ApiError(400, `Maximum quantity is ${CONFIG.maxQuantity}`);
    }

    const veg = await Vegetable.findById(item.vegetableId).lean();
    if (!veg)
      throw new ApiError(404, `Vegetable not found: ${item.vegetableId}`);

    try {
      const priceInfo = getPrice(veg, item.weight, item.quantity);
      calculatedItems.push({
        vegetableId: item.vegetableId,
        name: veg.name,
        pricingType: veg.pricingType,
        quantity: item.quantity,
        pricePerUnit: priceInfo.pricePerUnit,
        subtotal: priceInfo.subtotal,
        ...(priceInfo.type === "set"
          ? {
              weight: item.weight,
              setLabel: priceInfo.label,
              setQuantity: priceInfo.setQuantity,
              setUnit: priceInfo.setUnit,
            }
          : { weight: priceInfo.weight }),
      });
      subtotal += priceInfo.subtotal;
    } catch (error) {
      throw new ApiError(400, `Error processing ${veg.name}: ${error.message}`);
    }
  }

  let couponDiscount = 0,
    couponDetails = null;
  if (couponCode) {
    try {
      const v = await validateCoupon(couponCode, subtotal, null);
      couponDiscount = v.couponDiscount;
      couponDetails = v.couponDetails;
    } catch (error) {
      couponDetails = {
        code: couponCode,
        applied: false,
        error: error.message,
      };
    }
  }

  const subtotalAfterDiscount = Math.max(0, subtotal - couponDiscount);
  const freeDelivery = subtotalAfterDiscount > CONFIG.freeDeliveryThreshold;
  const delivery = freeDelivery ? 0 : CONFIG.deliveryCharges;

  res.json(
    new ApiResponse(
      200,
      {
        items: calculatedItems,
        coupon: couponDetails,
        summary: {
          subtotal,
          couponDiscount,
          subtotalAfterDiscount,
          deliveryCharges: delivery,
          freeDelivery,
          totalAmount: subtotalAfterDiscount + delivery,
        },
        timestamp: new Date().toISOString(),
      },
      "Price calculated",
    ),
  );
});

export const validateCouponForBasket = asyncHandler(async (req, res) => {
  const { basketId, basketPrice, couponCode } = req.body;

  if (!basketId || !basketPrice)
    throw new ApiError(400, "Basket ID and price required");
  if (!couponCode) throw new ApiError(400, "Coupon code required");

  const [basket, coupon] = await Promise.all([
    Basket.findById(basketId).select("price").lean(),
    Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true }).lean(),
  ]);

  if (!basket) throw new ApiError(404, "Basket not found");
  if (basket.price !== basketPrice)
    throw new ApiError(400, "Basket price mismatch");

  let couponDetails = null;
  let couponDiscount = 0;

  if (!coupon) {
    couponDetails = {
      code: couponCode,
      applied: false,
      error: "Invalid coupon code",
    };
  } else if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    couponDetails = {
      code: couponCode,
      applied: false,
      error: "Coupon has expired",
    };
  } else if (coupon.minOrderAmount && basketPrice < coupon.minOrderAmount) {
    couponDetails = {
      code: couponCode,
      applied: false,
      error: `Minimum order amount of ₹${coupon.minOrderAmount} required`,
    };
  } else if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    couponDetails = {
      code: couponCode,
      applied: false,
      error: "Coupon usage limit reached",
    };
  } else {
    couponDiscount =
      coupon.discountType === "percentage"
        ? Math.min(
            (basketPrice * coupon.discountValue) / 100,
            coupon.maxDiscount || Infinity,
          )
        : Math.min(coupon.discountValue, basketPrice);

    couponDetails = {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount: couponDiscount,
    };
  }

  const subtotalAfterDiscount = Math.max(0, basketPrice - couponDiscount);
  const totalAmount = subtotalAfterDiscount + CONFIG.deliveryCharges;

  return res.json(
    new ApiResponse(
      200,
      {
        coupon: couponDetails,
        basketPrice,
        couponDiscount,
        subtotalAfterDiscount,
        deliveryCharges: CONFIG.deliveryCharges,
        totalAmount,
      },
      "Coupon validation completed",
    ),
  );
});

// ================= ANALYTICS =================
export const getOrdersByDateTimeRange = asyncHandler(async (req, res) => {
  const { startDate, startTime, endDate, endTime } = req.query;
  if (!startDate || !startTime || !endDate || !endTime) {
    throw new ApiError(400, "All date-time parameters required");
  }

  const startDateTime = new Date(`${startDate}T${startTime}:00`);
  const endDateTime = new Date(`${endDate}T${endTime}:00`);

  if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
    throw new ApiError(400, "Invalid date or time format");
  }
  if (startDateTime > endDateTime) {
    throw new ApiError(400, "Start date-time cannot be after end date-time");
  }

  const orders = await Order.find({
    orderDate: { $gte: startDateTime, $lte: endDateTime },
    orderStatus: { $nin: ["delivered", "cancelled"] },
  })
    .populate("customerInfo", "name")
    .populate("selectedVegetables.vegetable", "name")
    .lean();

  if (!orders.length) {
    return res.json(
      new ApiResponse(
        200,
        {
          orders: [],
          totalOrders: 0,
          summary: {
            totalOrders: 0,
            totalRevenue: 0,
            totalVegetablesWeightKg: 0,
            totalVegetablesPieces: 0,
            uniqueVegetables: 0,
          },
          vegetableData: {},
        },
        "No orders found",
      ),
    );
  }

  const vegDataMap = new Map();
  let totalRevenue = 0;

  for (const order of orders) {
    totalRevenue += order.totalAmount || 0;

    for (const item of order.selectedVegetables) {
      const vegName = item.vegetable?.name || "Unknown";

      if (!vegDataMap.has(vegName)) {
        vegDataMap.set(vegName, {
          totalWeightKg: 0,
          totalWeightG: 0,
          totalPieces: 0,
          totalBundles: 0,
          orders: 0,
          breakdown: [],
        });
      }

      const veg = vegDataMap.get(vegName);
      const isSet = item.weight?.startsWith("set");

      let weightKg = 0,
        pieces = 0,
        bundles = 0,
        display = "";

      if (isSet) {
        const qty = (item.setQuantity || 0) * item.quantity;
        if (item.setUnit === "pieces") {
          pieces = qty;
          display = `${qty} pieces`;
        } else if (item.setUnit === "bundles") {
          bundles = qty;
          display = `${qty} bundles`;
        } else {
          pieces = qty;
          display = `${qty} ${item.setUnit}`;
        }
      } else {
        weightKg = (CONFIG.weightToKg.get(item.weight) || 0) * item.quantity;
        display =
          weightKg >= 1 ? `${weightKg}kg` : `${Math.round(weightKg * 1000)}g`;
      }

      veg.totalWeightKg += weightKg;
      veg.totalPieces += pieces;
      veg.totalBundles += bundles;
      veg.orders++;

      veg.breakdown.push({
        orderId: order.orderId,
        itemType: isSet ? item.setUnit : "weight",
        originalWeight: item.weight,
        quantity: item.quantity,
        ...(isSet && {
          setInfo: {
            setLabel: item.setLabel,
            setQuantity: item.setQuantity,
            setUnit: item.setUnit,
          },
        }),
        calculatedAmount: display,
        ...(weightKg > 0 && { weightKg }),
        ...(pieces > 0 && { pieces }),
        ...(bundles > 0 && { bundles }),
        customerName: order.customerInfo?.name || "Unknown",
        orderDate: order.orderDate,
      });
    }
  }

  let totalWeightKg = 0,
    totalPieces = 0;
  const vegData = {};

  for (const [vegName, veg] of vegDataMap) {
    veg.totalWeightKg = Math.round(veg.totalWeightKg * 100) / 100;
    veg.totalWeightG = Math.round(veg.totalWeightKg * 1000);

    const parts = [];
    if (veg.totalWeightKg > 0) parts.push(`${veg.totalWeightKg}kg`);
    if (veg.totalPieces > 0) parts.push(`${veg.totalPieces} pieces`);
    if (veg.totalBundles > 0) parts.push(`${veg.totalBundles} bundles`);
    veg.summary = parts.join(", ") || "No quantities";

    totalWeightKg += veg.totalWeightKg;
    totalPieces += veg.totalPieces + veg.totalBundles;

    vegData[vegName] = veg;
  }

  const summary = {
    totalOrders: orders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalVegetablesWeightKg: Math.round(totalWeightKg * 100) / 100,
    totalVegetablesPieces: totalPieces,
    uniqueVegetables: vegDataMap.size,
    dateRange: { from: startDate, to: endDate },
    timeRange: { from: startTime, to: endTime },
  };

  res.json(
    new ApiResponse(
      200,
      {
        dateTimeRange: { start: startDateTime, end: endDateTime },
        summary,
        vegetableData: vegData,
        orders: orders.map((order) => ({
          _id: order._id,
          orderId: order.orderId,
          customerName: order.customerInfo?.name,
          orderDate: order.orderDate,
          totalAmount: order.totalAmount,
          paymentStatus: order.paymentStatus,
          orderStatus: order.orderStatus,
          vegetables: order.selectedVegetables.map((item) => {
            const isSet = item.weight?.startsWith("set");
            return {
              name: item.vegetable?.name || "Unknown",
              weight: item.weight,
              quantity: item.quantity,
              subtotal: item.subtotal,
              type: isSet ? "set-based" : "weight-based",
              ...(isSet && {
                setInfo: {
                  label: item.setLabel,
                  quantity: item.setQuantity,
                  unit: item.setUnit,
                },
              }),
            };
          }),
        })),
      },
      "Orders retrieved successfully",
    ),
  );
});

export const getOrdersByStatus = asyncHandler(async (req, res) => {
  const { status, startDate, endDate } = req.query;

  if (!status) {
    throw new ApiError(400, "Status parameter required");
  }

  // ✅ FIX: Sanitize status to prevent NoSQL injection
  const sanitizedStatus = sanitizeString(status);

  const query = { orderStatus: new RegExp(`^${sanitizedStatus}$`, "i") };

  if (startDate || endDate) {
    query.orderDate = {};
    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      if (!isNaN(start.getTime())) query.orderDate.$gte = start;
    }
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59`);
      if (!isNaN(end.getTime())) query.orderDate.$lte = end;
    }
  }

  const orders = await Order.find(query)
    .populate("customerInfo", "name phone")
    .populate("selectedVegetables.vegetable", "name")
    .sort({ orderDate: -1 })
    .lean();

  if (!orders.length) {
    return res.json(
      new ApiResponse(
        200,
        {
          orders: [],
          totalOrders: 0,
          summary: { totalOrders: 0, totalRevenue: 0 },
          vegetableData: {},
        },
        `No orders found with status: ${sanitizedStatus}`,
      ),
    );
  }

  const vegDataMap = new Map();
  let totalRevenue = 0,
    totalWeightKg = 0,
    totalPieces = 0;

  for (const order of orders) {
    totalRevenue += order.totalAmount || 0;

    for (const item of order.selectedVegetables) {
      const vegName = item.vegetable?.name || "Unknown";
      if (!vegDataMap.has(vegName)) {
        vegDataMap.set(vegName, {
          totalWeightKg: 0,
          totalPieces: 0,
          totalBundles: 0,
          orders: 0,
        });
      }

      const veg = vegDataMap.get(vegName);
      const isSet = item.weight?.startsWith("set");

      if (isSet) {
        const qty = (item.setQuantity || 0) * item.quantity;
        if (item.setUnit === "pieces") veg.totalPieces += qty;
        else if (item.setUnit === "bundles") veg.totalBundles += qty;
        else veg.totalPieces += qty;
      } else {
        veg.totalWeightKg +=
          (CONFIG.weightToKg.get(item.weight) || 0) * item.quantity;
      }
      veg.orders++;
    }
  }

  const vegData = {};
  for (const [vegName, veg] of vegDataMap) {
    veg.totalWeightKg = Math.round(veg.totalWeightKg * 100) / 100;
    totalWeightKg += veg.totalWeightKg;
    totalPieces += veg.totalPieces + veg.totalBundles;
    vegData[vegName] = veg;
  }

  const summary = {
    totalOrders: orders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalVegetablesWeightKg: Math.round(totalWeightKg * 100) / 100,
    totalVegetablesPieces: totalPieces,
    uniqueVegetables: Object.keys(vegData).length,
    status: sanitizedStatus,
    ...(startDate && { dateFrom: startDate }),
    ...(endDate && { dateTo: endDate }),
  };

  res.json(
    new ApiResponse(
      200,
      { summary, vegetableData: vegData, orders },
      `Orders with status '${sanitizedStatus}' retrieved`,
    ),
  );
});

export const getOrdersByMultipleStatuses = asyncHandler(async (req, res) => {
  const { statuses, startDate, endDate } = req.query;

  if (!statuses) throw new ApiError(400, "Statuses parameter required");

  // ✅ FIX: Sanitize each status
  const statusSet = new Set(
    statuses.split(",").map((s) => sanitizeString(s.trim().toLowerCase())),
  );

  const query = {
    orderStatus: {
      $in: Array.from(statusSet).map((s) => new RegExp(`^${s}$`, "i")),
    },
  };

  if (startDate || endDate) {
    query.orderDate = {};
    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      if (!isNaN(start.getTime())) query.orderDate.$gte = start;
    }
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59`);
      if (!isNaN(end.getTime())) query.orderDate.$lte = end;
    }
  }

  const orders = await Order.find(query)
    .populate("customerInfo", "name")
    .populate("selectedVegetables.vegetable", "name")
    .sort({ orderDate: -1 })
    .lean();

  const ordersByStatusMap = new Map();
  statusSet.forEach((s) => ordersByStatusMap.set(s, []));

  let totalRevenue = 0;
  for (const order of orders) {
    const orderStatus = order.orderStatus.toLowerCase();
    if (ordersByStatusMap.has(orderStatus)) {
      ordersByStatusMap.get(orderStatus).push(order);
    }
    totalRevenue += order.totalAmount || 0;
  }

  const statusCounts = {};
  for (const [status, orderList] of ordersByStatusMap) {
    statusCounts[status] = orderList.length;
  }

  res.json(
    new ApiResponse(
      200,
      {
        totalOrders: orders.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        statusCounts,
        orders: orders.map((order) => ({
          _id: order._id,
          orderId: order.orderId,
          customerName: order.customerInfo?.name || "Unknown",
          orderDate: order.orderDate,
          totalAmount: order.totalAmount,
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus,
        })),
      },
      "Orders retrieved successfully",
    ),
  );
});

export const getOrderStatusStats = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.orderDate = {};
    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      if (!isNaN(start.getTime())) dateFilter.orderDate.$gte = start;
    }
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59`);
      if (!isNaN(end.getTime())) dateFilter.orderDate.$lte = end;
    }
  }

  const stats = await Order.aggregate([
    ...(Object.keys(dateFilter).length > 0 ? [{ $match: dateFilter }] : []),
    {
      $group: {
        _id: { $toLower: "$orderStatus" },
        count: { $sum: 1 },
        totalRevenue: { $sum: "$totalAmount" },
        avgOrderValue: { $avg: "$totalAmount" },
      },
    },
    {
      $project: {
        _id: 0,
        status: "$_id",
        count: 1,
        totalRevenue: { $round: ["$totalRevenue", 2] },
        avgOrderValue: { $round: ["$avgOrderValue", 2] },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const overallTotal = stats.reduce(
    (acc, stat) => ({
      totalOrders: acc.totalOrders + stat.count,
      totalRevenue: acc.totalRevenue + stat.totalRevenue,
    }),
    { totalOrders: 0, totalRevenue: 0 },
  );

  res.json(
    new ApiResponse(
      200,
      {
        overallTotal: {
          totalOrders: overallTotal.totalOrders,
          totalRevenue: Math.round(overallTotal.totalRevenue * 100) / 100,
        },
        statusBreakdown: stats,
        ...(startDate && { dateFrom: startDate }),
        ...(endDate && { dateTo: endDate }),
      },
      "Statistics retrieved successfully",
    ),
  );
});
