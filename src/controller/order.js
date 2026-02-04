import Order from "../Model/order.js";
import User from "../Model/user.js";
import Vegetable from "../Model/vegetable.js";
import Offer from "../Model/offer.js";
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
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

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
      subject: `Order #${order.orderId} - ${(order.totalAmount || 0).toFixed(2)}`,
      html,
    };

    await transporter.sendMail(mailOptions);
    // console.log(`Admin notification sent for order ${order.orderId}`);
  } catch (error) {
    console.error(
      `Failed to send admin notification for order ${order.orderId}:`,
      error.message,
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
      if (i === retries - 1) return `ORD${Date.now().toString().slice(-9)}`;
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
const getVegId = (item) =>
  typeof item === "string"
    ? item
    : item.vegetable
      ? typeof item.vegetable === "string"
        ? item.vegetable
        : item.vegetable._id || item.vegetable.id
      : item._id || item.id || item.name;

const processVegetables = async (items, isBasket = false) => {
  if (!Array.isArray(items) || !items.length) throw new Error("Items required");

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
  offer,
  vegetables,
  type = "custom",
) => {
  try {
    const [customerId, offerId, processedVegs] = await Promise.all([
      processCustomer(customer),
      type === "basket" && offer
        ? Offer.findById(typeof offer === "string" ? offer : offer._id, {
            _id: 1,
          })
            .lean()
            .then((o) => {
              if (!o) throw new Error("Offer not found");
              return o._id;
            })
        : null,
      processVegetables(vegetables, type === "basket"),
    ]);
    return { customerId, offerId, processedVegetables: processedVegs };
  } catch (error) {
    return { error: error.message };
  }
};

// ================= ORDER TOTAL CALCULATION =================
const calculateOrderTotal = (
  vegs,
  offerPrice = null,
  type = "custom",
  discount = 0,
) => {
  const vegTotal = vegs.reduce((sum, i) => sum + i.subtotal, 0);

  if (type === "basket") {
    if (!offerPrice) throw new Error("Offer price required");
    const afterDiscount = Math.max(0, offerPrice - discount);
    return {
      vegetablesTotal: vegTotal,
      offerPrice,
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
    offerPrice: 0,
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

// ================= ORDER CREATION WITH RETRY =================
const createOrderWithRetry = async (
  data,
  maxRetries = CONFIG.orderIdRetries,
) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // ✅ Use provided orderId if exists, otherwise generate new one
      const orderId = data.orderId || (await generateUniqueOrderId());
      const order = await Order.create({ ...data, orderId });
      return { order, orderId };
    } catch (err) {
      if (err.code === 11000 && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 50 << i));
        continue;
      }
      // ✅ Enhanced error logging
      console.error("❌ Order creation error:", {
        code: err.code,
        message: err.message,
        errors: err.errors,
        name: err.name,
      });
      throw err;
    }
  }
  throw new Error("Failed to create order");
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
  const page = parseInt(req.query.page) ;
  const limit = parseInt(req.query.limit);
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.status) filter.paymentStatus = req.query.status;
  if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
  if (req.query.orderType) filter.orderType = req.query.orderType;

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("customerInfo")
      .populate("deliveryAddressId")
      .populate("selectedOffer")
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
  if (!/^ORD\d{11}$/.test(orderId)) {
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));
  }

  const order = await Order.findOne({ orderId })
    .populate("customerInfo")
    .populate({ path: "deliveryAddress", populate: { path: "user" } })
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable")
    .lean();

  if (!order)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  res.json(new ApiResponse(200, order, "Order fetched"));
});

export const addOrder = asyncHandler(async (req, res) => {
  const {
    customerInfo,
    selectedOffer,
    selectedVegetables,
    paymentMethod,
    orderType,
    couponCode,
    deliveryAddressId,
  } = req.body;
<<<<<<< HEAD
  console.log({
    customerInfo,
    selectedBasket,
    selectedVegetables,
    paymentMethod,
    orderType,
    couponCode,
    deliveryAddressId,
  });
=======

>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  // Validation
  if (!customerInfo)
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Customer info required"));
  if (!["basket", "custom"].includes(orderType))
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid order type"));
  if (orderType === "basket" && !selectedOffer)
    return res.status(400).json(new ApiResponse(400, null, "Offer required"));
  if (!Array.isArray(selectedVegetables) || !selectedVegetables.length) {
    return res.status(400).json(new ApiResponse(400, null, "Items required"));
  }
  if (!["COD", "ONLINE"].includes(paymentMethod))
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid payment method"));

  const processed = await processOrderData(
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderType,
  );
  if (processed.error)
    return res.status(400).json(new ApiResponse(400, null, processed.error));

  const { customerId, offerId, processedVegetables } = processed;

  let subtotal =
    orderType === "basket"
      ? (await Offer.findById(offerId, { price: 1 }).lean()).price
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
      return res.status(400).json(new ApiResponse(400, null, err.message));
    }
  }

  const totals = calculateOrderTotal(
    processedVegetables,
    orderType === "basket"
      ? (await Offer.findById(offerId, { price: 1 }).lean()).price
      : null,
    orderType,
    couponDiscount,
  );
  if (paymentMethod === "COD") {
    let stockUpdates;
    try {
      stockUpdates = await updateStock(processedVegetables, "deduct");
    } catch (err) {
      return res.status(400).json(new ApiResponse(400, null, err.message));
    }

    let result;
    try {
      // ✅ Pass orderId explicitly in the data object
      const orderId = await generateUniqueOrderId();

      result = await createOrderWithRetry({
        orderId, // ✅ Explicitly pass orderId
        orderType,
        customerInfo: customerId,
        selectedVegetables: processedVegetables,
        orderDate: new Date(),
        couponCode: validatedCode,
        couponId,
        ...totals,
        paymentMethod: "COD",
        paymentStatus: "pending",
        orderStatus: "placed",
        stockUpdates,
        deliveryAddressId,
        ...(orderType === "basket" && { selectedOffer: offerId }),
      });
    } catch (err) {
      console.error("❌ COD Order creation failed:", err);
      await updateStock(processedVegetables, "restore");
      return res.status(500).json(new ApiResponse(500, null, err.message));
    }

    if (couponId) await incrementCouponUsage(couponId, customerId);
    await User.findByIdAndUpdate(customerId, {
      $push: { orders: result.order._id },
    });

    const populated = await Order.findById(result.order._id)
      .populate("customerInfo", "name email phone")
      .populate("deliveryAddressId")
      .populate("selectedOffer")
      .populate("selectedVegetables.vegetable", "name")
      .lean();

    processOrderInvoice(populated._id, {
      sendEmail: true,
      emailType: "invoice",
    }).catch(console.error);
<<<<<<< HEAD

=======
    
    // Send admin notification
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
    sendAdminOrderNotification(populated).catch(console.error);
    
    return res.json(new ApiResponse(201, populated, "Order placed with COD"));
  }

  const orderId = await generateUniqueOrderId();
  const razorpayOrder = await razorpay.orders.create({
    amount: Math.round(totals.totalAmount * 100),
    currency: "INR",
    receipt: orderId,
    payment_capture: 1,
  });

  res.json(
    new ApiResponse(
      201,
      {
        razorpayOrder,
        orderData: {
          orderType,
          customerInfo: customerId,
          selectedVegetables: processedVegetables,
          orderId,
          couponCode: validatedCode,
          couponId,
          ...totals,
          deliveryAddressId,
          ...(orderType === "basket" && { selectedOffer: offerId }),
        },
      },
      "Razorpay order created",
    ),
  );
});

export const verifyPayment = asyncHandler(async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderId, // ✅ This comes from frontend
    orderType,
    couponCode,
    deliveryAddressId,
  } = req.body;

<<<<<<< HEAD
  // ✅ Enhanced logging
  console.log("📥 Verify Payment Request:", {
    razorpay_order_id,
    razorpay_payment_id,
    orderId,
    orderType,
    vegetablesCount: selectedVegetables?.length,
  });

  // ============ VALIDATION ============
=======
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
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
  if (orderType === "basket" && !selectedOffer) {
    return res.status(400).json(new ApiResponse(400, null, "Missing offer"));
  }

<<<<<<< HEAD
  // ============ VERIFY SIGNATURE ============
=======
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSig !== razorpay_signature) {
<<<<<<< HEAD
    console.error("❌ Invalid signature");
=======
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Invalid signature"));
  }
<<<<<<< HEAD
  console.log("✅ Signature verified");

  // ============ CHECK DUPLICATE PAYMENT ============
=======
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  if (await Order.exists({ razorpayPaymentId: razorpay_payment_id })) {
    return res.status(400).json(new ApiResponse(400, null, "Order exists"));
  }

<<<<<<< HEAD
  // ============ PROCESS ORDER DATA ============
  console.log("🔄 Processing order data...");
=======
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  const processed = await processOrderData(
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderType,
  );
  if (processed.error)
    return res.status(400).json(new ApiResponse(400, null, processed.error));

<<<<<<< HEAD
  const { customerId, basketId, processedVegetables } = processed;
  console.log("✅ Order data processed");

  // ============ CALCULATE SUBTOTAL ============
=======
  const { customerId, offerId, processedVegetables } = processed;

>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  let subtotal =
    orderType === "basket"
      ? (await Offer.findById(offerId, { price: 1 }).lean()).price
      : processedVegetables.reduce((sum, i) => sum + i.subtotal, 0);

<<<<<<< HEAD
  // ============ VALIDATE COUPON ============
=======
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  let couponId = null,
    couponDiscount = 0,
    validatedCode = null;
  if (couponCode) {
    try {
      const v = await validateCoupon(couponCode, subtotal, customerId);
      couponId = v.couponId;
      couponDiscount = v.couponDiscount;
      validatedCode = v.validatedCouponCode;
<<<<<<< HEAD
      console.log("✅ Coupon validated:", validatedCode);
    } catch (err) {
      console.warn("⚠️ Coupon validation failed:", err.message);
    }
  }

  // ============ CALCULATE TOTALS ============
=======
    } catch (err) {
      console.error("Coupon error:", err.message);
    }
  }

>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  const totals = calculateOrderTotal(
    processedVegetables,
    orderType === "basket"
      ? (await Offer.findById(offerId, { price: 1 }).lean()).price
      : null,
    orderType,
    couponDiscount,
  );

<<<<<<< HEAD
  // ============ UPDATE STOCK ============
  let stockUpdates;
  try {
    stockUpdates = await updateStock(processedVegetables, "deduct");
    console.log("✅ Stock updated:", stockUpdates.length, "items");
=======
  let stockUpdates;
  try {
    stockUpdates = await updateStock(processedVegetables, "deduct");
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  } catch (err) {
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Stock unavailable"));
  }

<<<<<<< HEAD
  // ============ CREATE ORDER ============
  let result;
  try {
    console.log("💾 Creating order with orderId:", orderId);

    // ✅ Prepare complete order data
    const orderData = {
      orderId, // ✅ Use orderId from frontend (from Razorpay receipt)
=======
  let result;
  try {
    result = await createOrderWithRetry({
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
      orderType,
      customerInfo: customerId,
      selectedVegetables: processedVegetables,
      orderDate: new Date(),
      couponCode: validatedCode,
      couponId,
      ...totals,
<<<<<<< HEAD
=======
      orderId,
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
      paymentMethod: "ONLINE",
      orderStatus: "placed",
      paymentStatus: "completed",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      stockUpdates,
      deliveryAddressId,
<<<<<<< HEAD
      ...(orderType === "basket" && { selectedBasket: basketId }),
    };

    // ✅ Debug log before creation
    console.log("📋 Order data prepared:", {
      orderId: orderData.orderId,
      customerInfo: orderData.customerInfo,
      totalAmount: orderData.totalAmount,
      vegetablesCount: orderData.selectedVegetables.length,
    });

    result = await createOrderWithRetry(orderData);

    console.log("✅ Order created:", {
      orderId: result.orderId,
      dbId: result.order._id,
    });
  } catch (err) {
    console.error("❌ Order creation failed:", {
      name: err.name,
      message: err.message,
      code: err.code,
      errors: err.errors,
    });

    // Restore stock on failure
    try {
      await updateStock(processedVegetables, "restore");
      console.log("✅ Stock restored after failed order creation");
    } catch (restoreErr) {
      console.error("❌ Failed to restore stock:", restoreErr.message);
    }

    return res.status(500).json(new ApiResponse(500, null, err.message));
  }

  // ============ POST-ORDER UPDATES ============
  if (couponId) {
    try {
      await incrementCouponUsage(couponId, customerId);
      console.log("✅ Coupon usage incremented");
    } catch (err) {
      console.error("⚠️ Failed to increment coupon usage:", err.message);
    }
  }

  try {
    await User.findByIdAndUpdate(customerId, {
      $push: { orders: result.order._id },
    });
    console.log("✅ User orders updated");
  } catch (err) {
    console.error("⚠️ Failed to update user orders:", err.message);
  }

  // ============ POPULATE ORDER DETAILS ============
=======
      ...(orderType === "basket" && { selectedOffer: offerId }),
    });
  } catch (err) {
    await updateStock(processedVegetables, "restore");
    return res.status(500).json(new ApiResponse(500, null, err.message));
  }

  if (couponId) await incrementCouponUsage(couponId, customerId);
  await User.findByIdAndUpdate(customerId, {
    $push: { orders: result.order._id },
  });

>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  const populated = await Order.findById(result.order._id)
    .populate("customerInfo", "name email phone")
    .populate("deliveryAddressId")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable", "name")
    .lean();

<<<<<<< HEAD
  console.log("✅ Order populated");

  // ============ SEND NOTIFICATIONS (ASYNC) ============
  processOrderInvoice(populated._id, {
    sendEmail: true,
    emailType: "invoice",
  }).catch((err) => {
    console.error("⚠️ Invoice email failed:", err.message);
  });

  sendAdminOrderNotification(populated).catch((err) => {
    console.error("⚠️ Admin notification failed:", err.message);
  });

  console.log("🎉 Payment verification completed successfully");
=======
  processOrderInvoice(populated._id, {
    sendEmail: true,
    emailType: "invoice",
  }).catch(console.error);
  
  // Send admin notification
  sendAdminOrderNotification(populated).catch(console.error);
  
>>>>>>> parent of edbe6bb (feat: Implement wallet, order, and basket management features, including API response utilities and authentication middleware.)
  res.json(new ApiResponse(200, populated, "Payment verified"));
});

export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { orderStatus } = req.body;

  if (!CONFIG.validStatuses.has(orderStatus)) {
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

  if (orderStatus === "cancelled" && current.orderStatus !== "cancelled") {
    try {
      await updateStock(current.selectedVegetables, "restore");
    } catch (err) {
      console.error("Stock restore error:", err.message);
    }
  }

  const order = await Order.findByIdAndUpdate(
    _id,
    { orderStatus, paymentStatus: "completed" },
    { new: true, runValidators: true },
  )
    .populate("customerInfo", "name email mobile phone address city area state")
    .populate("selectedOffer")
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
          <h3 style="color: #e57512; text-transform: uppercase; margin: 20px 0;">${orderStatus}</h3>
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
    }).catch((err) =>
      console.error(
        `Failed to send status email for order ${order.orderId}:`,
        err.message,
      ),
    );
  }

  res.json(new ApiResponse(200, order, "Order status updated"));
});

export const getRazorpayKey = asyncHandler(async (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID) {
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Razorpay key not configured"));
  }
  res.json(
    new ApiResponse(200, { key: process.env.RAZORPAY_KEY_ID }, "Key fetched"),
  );
});

export const calculatePrice = asyncHandler(async (req, res) => {
  const { items, couponCode } = req.body;
  if (!items || !Array.isArray(items) || !items.length)
    throw new ApiError(400, "Items required");

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
  const { offerId, offerPrice, couponCode } = req.body;

  if (!offerId || !offerPrice)
    throw new ApiError(400, "Offer ID and price are required");
  if (!couponCode) throw new ApiError(400, "Coupon code is required");

  const [offer, coupon] = await Promise.all([
    Offer.findById(offerId).select("price").lean(),
    Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true }).lean(),
  ]);

  if (!offer) throw new ApiError(404, "Offer not found");
  if (offer.price !== offerPrice)
    throw new ApiError(400, "Offer price mismatch");

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
  } else if (coupon.minOrderAmount && offerPrice < coupon.minOrderAmount) {
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
            (offerPrice * coupon.discountValue) / 100,
            coupon.maxDiscount || Infinity,
          )
        : Math.min(coupon.discountValue, offerPrice);

    couponDetails = {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount: couponDiscount,
    };
  }

  const subtotalAfterDiscount = Math.max(0, offerPrice - couponDiscount);
  const totalAmount = subtotalAfterDiscount + CONFIG.deliveryCharges;

  return res.json(
    new ApiResponse(
      200,
      {
        coupon: couponDetails,
        offerPrice,
        couponDiscount,
        subtotalAfterDiscount,
        deliveryCharges: CONFIG.deliveryCharges,
        totalAmount,
      },
      "Coupon validation completed",
    ),
  );
});

// ================= ADVANCED ANALYTICS WITH HASHMAP AGGREGATION =================
export const getOrdersByDateTimeRange = asyncHandler(async (req, res) => {
  const { startDate, startTime, endDate, endTime } = req.query;

  if (!startDate || !startTime || !endDate || !endTime) {
    throw new ApiError(400, "All date-time parameters are required");
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
    orderStatus: { $nin: ["delivered", "cancelled", "Delivered", "Cancelled"] },
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
    const status = (order.orderStatus || "").toLowerCase();
    if (status === "cancelled" || status === "delivered") continue;

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
    throw new ApiError(400, "Status parameter is required");
  }

  const query = { orderStatus: new RegExp(`^${status}$`, "i") };

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
        `No orders found with status: ${status}`,
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
    status,
    ...(startDate && { dateFrom: startDate }),
    ...(endDate && { dateTo: endDate }),
  };

  res.json(
    new ApiResponse(
      200,
      { summary, vegetableData: vegData, orders },
      `Orders with status '${status}' retrieved successfully`,
    ),
  );
});

export const getOrdersByMultipleStatuses = asyncHandler(async (req, res) => {
  const { statuses, startDate, endDate } = req.query;

  if (!statuses) throw new ApiError(400, "Statuses parameter is required");

  const statusSet = new Set(
    statuses.split(",").map((s) => s.trim().toLowerCase()),
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
