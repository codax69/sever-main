import Order from "../Model/order.js";
import Customer from "../Model/customer.js";
import Vegetable from "../Model/vegetable.js";
import Offer from "../Model/offer.js";
import Coupon from "../Model/coupon.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";
import { incrementCouponUsage } from "./coupon.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import "dotenv/config";
import { DELIVERY_CHARGES } from "../../const.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// ============================================================================
// CONSTANTS & CONFIGS (Memory efficient)
// ============================================================================

const WEIGHT_TO_KG = Object.freeze({
  "1kg": 1,
  "500g": 0.5,
  "250g": 0.25,
  "100g": 0.1,
});

const WEIGHT_PRICE_MAP = Object.freeze({
  "1kg": "weight1kg",
  "500g": "weight500g",
  "250g": "weight250g",
  "100g": "weight100g",
});

const VALID_ORDER_STATUSES = Object.freeze([
  "placed",
  "processed",
  "shipped",
  "delivered",
  "cancelled",
]);

const DELIVERY_CHARGES_RUPEES = DELIVERY_CHARGES / 100;
const FREE_DELIVERY_THRESHOLD = 250;

// ============================================================================
// PRICING HELPER FUNCTIONS (Optimized)
// ============================================================================

function getPriceForSet(vegetable, setIndex) {
  const sets = vegetable.setPricing?.sets;
  if (!vegetable.setPricing?.enabled || !sets) {
    throw new Error(
      `Vegetable ${vegetable.name} does not have set pricing enabled`
    );
  }

  const setOption = sets[setIndex];
  if (!setOption) {
    throw new Error(
      `Invalid set index: ${setIndex}. Available sets: 0-${sets.length - 1}`
    );
  }

  return {
    price: setOption.price,
    quantity: setOption.quantity,
    unit: setOption.unit,
    label: `${setOption.quantity} ${setOption.unit}`,
  };
}

function getPriceForWeight(vegetable, weight) {
  const priceKey = WEIGHT_PRICE_MAP[weight];
  const price = vegetable.prices?.[priceKey];

  if (!priceKey || !price) {
    throw new Error(
      `Invalid weight: ${weight}. Must be one of: 1kg, 500g, 250g, 100g`
    );
  }
  return price;
}

function getPrice(vegetable, weightOrSet, quantity = 1) {
  const isSetBased =
    vegetable.pricingType === "set" || vegetable.setPricing?.enabled;

  if (isSetBased) {
    const setIndex = weightOrSet.startsWith("set")
      ? parseInt(weightOrSet.slice(3))
      : parseInt(weightOrSet);

    const setInfo = getPriceForSet(vegetable, setIndex);

    return {
      type: "set",
      pricePerUnit: setInfo.price,
      subtotal: setInfo.price * quantity,
      label: setInfo.label,
      setIndex,
      setQuantity: setInfo.quantity,
      setUnit: setInfo.unit,
    };
  }

  const pricePerUnit = getPriceForWeight(vegetable, weightOrSet);
  return {
    type: "weight",
    pricePerUnit,
    subtotal: pricePerUnit * quantity,
    weight: weightOrSet,
  };
}

// ============================================================================
// STOCK CALCULATION FUNCTIONS (Optimized)
// ============================================================================

function calculateKgFromWeight(weight, quantity) {
  return (WEIGHT_TO_KG[weight] || 0) * quantity;
}

function calculatePiecesFromSet(vegetable, setIndex, quantity) {
  const setOption = vegetable.setPricing.sets[setIndex];
  if (!setOption) {
    throw new Error(`Invalid set index: ${setIndex}`);
  }
  return setOption.quantity * quantity;
}

async function deductVegetableStock(selectedVegetables) {
  const stockUpdates = [];
  const bulkOps = [];

  // First pass: Validate all items
  for (const item of selectedVegetables) {
    const vegetable = await Vegetable.findById(item.vegetable).lean();
    if (!vegetable) {
      throw new Error(`Vegetable not found: ${item.vegetable}`);
    }

    const isSetBased =
      vegetable.pricingType === "set" || vegetable.setPricing?.enabled;

    if (isSetBased) {
      const setIndex = item.setIndex ?? parseInt(item.weight?.slice(3) || "0");
      const piecesToDeduct = calculatePiecesFromSet(
        vegetable,
        setIndex,
        item.quantity
      );

      if (vegetable.stockPieces < piecesToDeduct) {
        throw new Error(
          `Insufficient stock for ${vegetable.name}. Available: ${vegetable.stockPieces} pieces, Required: ${piecesToDeduct} pieces`
        );
      }

      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        deducted: piecesToDeduct,
        previousStock: vegetable.stockPieces,
        type: "pieces",
      });

      bulkOps.push({
        updateOne: {
          filter: { _id: item.vegetable },
          update: {
            $inc: { stockPieces: -piecesToDeduct },
            $set: { outOfStock: vegetable.stockPieces - piecesToDeduct <= 0 },
          },
        },
      });
    } else {
      const kgToDeduct = calculateKgFromWeight(item.weight, item.quantity);

      if (vegetable.stockKg < kgToDeduct) {
        throw new Error(
          `Insufficient stock for ${vegetable.name}. Available: ${vegetable.stockKg}kg, Required: ${kgToDeduct}kg`
        );
      }

      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        deducted: kgToDeduct,
        previousStock: vegetable.stockKg,
        type: "kg",
      });

      bulkOps.push({
        updateOne: {
          filter: { _id: item.vegetable },
          update: {
            $inc: { stockKg: -kgToDeduct },
            $set: { outOfStock: vegetable.stockKg - kgToDeduct < 0.25 },
          },
        },
      });
    }
  }

  // Bulk update all stocks at once (much faster)
  if (bulkOps.length > 0) {
    await Vegetable.bulkWrite(bulkOps);
  }

  return stockUpdates;
}

async function restoreVegetableStock(selectedVegetables) {
  const stockUpdates = [];
  const bulkOps = [];

  for (const item of selectedVegetables) {
    const vegetable = await Vegetable.findById(item.vegetable).lean();
    if (!vegetable) continue;

    const isSetBased =
      vegetable.pricingType === "set" || vegetable.setPricing?.enabled;

    if (isSetBased) {
      const setIndex = item.setIndex ?? parseInt(item.weight?.slice(3) || "0");
      const piecesToRestore = calculatePiecesFromSet(
        vegetable,
        setIndex,
        item.quantity
      );

      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        restored: piecesToRestore,
        newStock: vegetable.stockPieces + piecesToRestore,
        type: "pieces",
      });

      bulkOps.push({
        updateOne: {
          filter: { _id: item.vegetable },
          update: {
            $inc: { stockPieces: piecesToRestore },
            $set: { outOfStock: false },
          },
        },
      });
    } else {
      const kgToRestore = calculateKgFromWeight(item.weight, item.quantity);

      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        restored: kgToRestore,
        newStock: vegetable.stockKg + kgToRestore,
        type: "kg",
      });

      bulkOps.push({
        updateOne: {
          filter: { _id: item.vegetable },
          update: {
            $inc: { stockKg: kgToRestore },
            $set: {
              outOfStock:
                vegetable.stockKg + kgToRestore >= 0.25 ? false : true,
            },
          },
        },
      });
    }
  }

  // Bulk update all stocks at once
  if (bulkOps.length > 0) {
    await Vegetable.bulkWrite(bulkOps);
  }

  return stockUpdates;
}

// ============================================================================
// ORDER PROCESSING HELPER FUNCTIONS (Optimized)
// ============================================================================

async function processCustomer(customerInfo) {
  if (typeof customerInfo === "string") {
    const exists = await Customer.exists({ _id: customerInfo });
    if (!exists) throw new Error("Customer not found");
    return customerInfo;
  }

  if (customerInfo._id) return customerInfo._id;

  if (!customerInfo.mobile || !customerInfo.name) {
    throw new Error("Customer name and mobile are required");
  }

  const updateData = {
    name: customerInfo.name,
    mobile: customerInfo.mobile,
    ...(customerInfo.city && { city: customerInfo.city }),
    ...(customerInfo.area && { area: customerInfo.area }),
    ...(customerInfo.email && { email: customerInfo.email }),
    ...(customerInfo.address && { address: customerInfo.address }),
  };

  try {
    const customer = await Customer.findOneAndUpdate(
      { mobile: customerInfo.mobile },
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );
    return customer._id;
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const query =
        field === "email" && customerInfo.email
          ? { email: customerInfo.email }
          : { mobile: customerInfo.mobile };

      const customer = await Customer.findOneAndUpdate(
        query,
        { $set: updateData },
        { new: true, runValidators: true }
      );
      return customer._id;
    }
    throw error;
  }
}

async function processOffer(selectedOffer) {
  if (!selectedOffer) return null;

  let query = {};

  if (typeof selectedOffer === "string") {
    if (!/^[0-9a-fA-F]{24}$/.test(selectedOffer)) {
      throw new Error("Invalid offer ID format");
    }
    query = { _id: selectedOffer };
  } else if (selectedOffer._id) {
    query = { _id: selectedOffer._id };
  } else if (selectedOffer.name) {
    query = { name: selectedOffer.name };
  } else {
    throw new Error("Invalid offer data");
  }

  const offer = await Offer.findOne(query).select("_id").lean();
  if (!offer) throw new Error("Offer not found");

  return offer._id;
}

function getVegetableIdentifier(item) {
  if (typeof item === "string") return item;
  if (item.vegetable) {
    return typeof item.vegetable === "string"
      ? item.vegetable
      : item.vegetable._id || item.vegetable.id;
  }
  return item._id || item.id || item.name;
}

async function processVegetables(selectedVegetables, isFromBasket = false) {
  if (!Array.isArray(selectedVegetables) || selectedVegetables.length === 0) {
    throw new Error("selectedVegetables must be a non-empty array");
  }

  const uniqueVegIds = [
    ...new Set(selectedVegetables.map(getVegetableIdentifier).filter(Boolean)),
  ];

  if (uniqueVegIds.length === 0) {
    throw new Error("No valid vegetable identifiers found");
  }

  const isObjectId = /^[0-9a-fA-F]{24}$/.test(uniqueVegIds[0]);

  // Use lean() for better performance
  const vegetables = await Vegetable.find(
    isObjectId
      ? { _id: { $in: uniqueVegIds } }
      : {
          $or: [
            { name: { $in: uniqueVegIds } },
            { _id: { $in: uniqueVegIds } },
          ],
        }
  ).lean();

  if (vegetables.length !== uniqueVegIds.length) {
    const foundIds = vegetables.map((v) => v._id.toString());
    const missingIds = uniqueVegIds.filter(
      (id) => !foundIds.includes(id) && !vegetables.find((v) => v.name === id)
    );
    throw new Error(
      `Some vegetables not found. Expected ${uniqueVegIds.length}, found ${vegetables.length}. Missing IDs: ${missingIds.join(", ")}`
    );
  }

  // Use object instead of Map for better performance with small datasets
  const vegMap = {};
  vegetables.forEach((veg) => {
    vegMap[veg._id.toString()] = veg;
    vegMap[veg.name] = veg;
  });

  const groupedItems = {};

  selectedVegetables.forEach((item) => {
    const identifier = getVegetableIdentifier(item);
    const vegetable = vegMap[identifier];

    if (!vegetable) {
      throw new Error(`Vegetable not found: ${identifier}`);
    }

    const weightOrSet = (typeof item === "object" && item?.weight) || "1kg";
    const quantity = (typeof item === "object" && item?.quantity) || 1;
    const groupKey = `${vegetable._id}_${weightOrSet}`;

    if (groupedItems[groupKey]) {
      const existing = groupedItems[groupKey];
      existing.quantity += quantity;
      existing.subtotal = existing.pricePerUnit * existing.quantity;
    } else {
      const priceInfo = getPrice(vegetable, weightOrSet, quantity);

      const itemData = {
        vegetable: vegetable._id,
        quantity,
        pricePerUnit: priceInfo.pricePerUnit,
        subtotal: priceInfo.subtotal,
        isFromBasket,
      };

      if (priceInfo.type === "set") {
        itemData.weight = weightOrSet;
        itemData.setIndex = priceInfo.setIndex;
        itemData.setLabel = priceInfo.label;
        itemData.setQuantity = priceInfo.setQuantity;
        itemData.setUnit = priceInfo.setUnit;
      } else {
        itemData.weight = priceInfo.weight;
      }

      groupedItems[groupKey] = itemData;
    }
  });

  return Object.values(groupedItems);
}

async function processOrderData(
  customerInfo,
  selectedOffer,
  selectedVegetables,
  orderType = "custom"
) {
  try {
    const isBasketOrder = orderType === "basket";

    // Process in parallel for better performance
    const [customerId, offerId, processedVegetables] = await Promise.all([
      processCustomer(customerInfo),
      isBasketOrder ? processOffer(selectedOffer) : Promise.resolve(null),
      processVegetables(selectedVegetables, isBasketOrder),
    ]);

    return { customerId, offerId, processedVegetables };
  } catch (error) {
    return { error: error.message };
  }
}

function calculateOrderTotal(
  processedVegetables,
  offerPrice = null,
  orderType = "custom",
  couponDiscount = 0
) {
  const vegetablesTotal = processedVegetables.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  if (orderType === "basket") {
    if (!offerPrice)
      throw new Error("Offer price is required for basket orders");

    const subtotalAfterDiscount = Math.max(0, offerPrice - couponDiscount);
    return {
      vegetablesTotal,
      offerPrice,
      couponDiscount,
      subtotalAfterDiscount,
      deliveryCharges: DELIVERY_CHARGES_RUPEES,
      totalAmount: subtotalAfterDiscount + DELIVERY_CHARGES_RUPEES,
    };
  }

  const subtotalAfterDiscount = Math.max(0, vegetablesTotal - couponDiscount);
  const appliedDeliveryCharges =
    subtotalAfterDiscount > FREE_DELIVERY_THRESHOLD
      ? 0
      : DELIVERY_CHARGES_RUPEES;

  return {
    vegetablesTotal,
    offerPrice: 0,
    couponDiscount,
    subtotalAfterDiscount,
    deliveryCharges: appliedDeliveryCharges,
    totalAmount: subtotalAfterDiscount + appliedDeliveryCharges,
  };
}

async function validateAndApplyCoupon(couponCode, subtotal, customerId = null) {
  if (!couponCode) {
    return {
      couponId: null,
      couponDiscount: 0,
      validatedCouponCode: null,
      couponDetails: null,
    };
  }

  const coupon = await Coupon.findOne({
    code: couponCode.toUpperCase(),
    isActive: true,
  }).lean();

  if (!coupon) throw new Error("Invalid coupon code");

  // Check expiry
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    throw new Error("Coupon has expired");
  }

  // Check minimum order amount
  if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount) {
    throw new Error(
      `Minimum order amount of ₹${coupon.minOrderAmount} required for this coupon`
    );
  }

  // Check usage limits
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw new Error("Coupon usage limit reached");
  }

  // Check per-user limit
  if (customerId && coupon.perUserLimit) {
    const userUsageCount =
      coupon.usedBy?.filter((id) => id.toString() === customerId.toString())
        .length || 0;
    if (userUsageCount >= coupon.perUserLimit) {
      throw new Error("You have reached the usage limit for this coupon");
    }
  }

  // Calculate discount inline instead of method call
  const couponDiscount =
    coupon.discountType === "percentage"
      ? Math.min(
          (subtotal * coupon.discountValue) / 100,
          coupon.maxDiscount || Infinity
        )
      : Math.min(coupon.discountValue, subtotal);

  return {
    couponId: coupon._id,
    couponDiscount,
    validatedCouponCode: coupon.code,
    couponDetails: {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount: couponDiscount,
    },
  };
}

// ============================================================================
// EXPORTED CONTROLLER FUNCTIONS
// ============================================================================

export const calculateTodayOrderTotal = asyncHandler(async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const count = await Order.countDocuments({
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });

  res.json(
    new ApiResponse(200, { count }, "Today's order count fetched successfully")
  );
});

export const getOrders = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.status) filter.paymentStatus = req.query.status;
  if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
  if (req.query.orderType) filter.orderType = req.query.orderType;

  // Execute count and find in parallel
  const [totalOrders, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("customerInfo")
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
          totalPages: Math.ceil(totalOrders / limit),
          totalOrders,
          hasMore: page * limit < totalOrders,
        },
      },
      "Orders fetched successfully"
    )
  );
});

export const getOrderById = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  if (!/^ORD\d{11}$/.test(orderId)) {
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));
  }

  const order = await Order.findOne({ orderId })
    .populate("customerInfo")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable")
    .lean();

  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  res.json(new ApiResponse(200, order, "Order fetched successfully"));
});

export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { orderStatus } = req.body;

  if (!orderStatus || !VALID_ORDER_STATUSES.includes(orderStatus)) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          `Invalid order status. Must be one of: ${VALID_ORDER_STATUSES.join(", ")}`
        )
      );
  }

  const currentOrder = await Order.findById(_id).lean();
  if (!currentOrder) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  // Restore stock if cancelling
  if (orderStatus === "cancelled" && currentOrder.orderStatus !== "cancelled") {
    try {
      await restoreVegetableStock(currentOrder.selectedVegetables);
    } catch (error) {
      console.error("Error restoring stock:", error.message);
    }
  }

  const order = await Order.findByIdAndUpdate(
    _id,
    { orderStatus },
    { new: true, runValidators: true }
  )
    .populate("customerInfo")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable");

  res.json(new ApiResponse(200, order, "Order status updated successfully"));
});

export const addOrder = asyncHandler(async (req, res) => {
  const {
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderId,
    paymentMethod,
    orderType,
    couponCode,
  } = req.body;

  // Validation
  if (!customerInfo) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Customer information is required"));
  }

  if (!["basket", "custom"].includes(orderType)) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          "Invalid order type. Must be 'basket' or 'custom'"
        )
      );
  }

  if (orderType === "basket" && !selectedOffer) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          "Offer selection is required for basket orders"
        )
      );
  }

  if (!Array.isArray(selectedVegetables) || selectedVegetables.length === 0) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "At least one vegetable must be selected")
      );
  }

  if (!orderId) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Order ID is required"));
  }

  if (!["COD", "ONLINE"].includes(paymentMethod)) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          "Valid payment method (COD or ONLINE) is required"
        )
      );
  }

  // Process order data
  const processed = await processOrderData(
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderType
  );

  if (processed.error) {
    return res.status(400).json(new ApiResponse(400, null, processed.error));
  }

  const { customerId, offerId, processedVegetables } = processed;

  // Calculate subtotal for coupon
  let subtotalForCoupon;
  if (orderType === "basket") {
    const offer = await Offer.findById(offerId).select("price").lean();
    if (!offer) {
      return res
        .status(404)
        .json(new ApiResponse(404, null, "Offer not found"));
    }
    subtotalForCoupon = offer.price;
  } else {
    subtotalForCoupon = processedVegetables.reduce(
      (sum, item) => sum + item.subtotal,
      0
    );
  }

  // Validate coupon
  let couponId = null;
  let couponDiscount = 0;
  let validatedCouponCode = null;

  if (couponCode) {
    try {
      const couponValidation = await validateAndApplyCoupon(
        couponCode,
        subtotalForCoupon,
        customerId
      );
      couponId = couponValidation.couponId;
      couponDiscount = couponValidation.couponDiscount;
      validatedCouponCode = couponValidation.validatedCouponCode;
    } catch (error) {
      return res.status(400).json(new ApiResponse(400, null, error.message));
    }
  }

  // Calculate totals
  let totals;
  if (orderType === "basket") {
    const offer = await Offer.findById(offerId).select("price").lean();
    const subtotalAfterDiscount = Math.max(0, offer.price - couponDiscount);
    totals = {
      vegetablesTotal: 0,
      offerPrice: offer.price,
      couponDiscount,
      subtotalAfterDiscount,
      deliveryCharges: DELIVERY_CHARGES_RUPEES,
      totalAmount: subtotalAfterDiscount + DELIVERY_CHARGES_RUPEES,
    };
  } else {
    totals = calculateOrderTotal(
      processedVegetables,
      null,
      orderType,
      couponDiscount
    );
  }

  // COD payment
  if (paymentMethod === "COD") {
    let stockUpdates;
    try {
      stockUpdates = await deductVegetableStock(processedVegetables);
    } catch (error) {
      return res.status(400).json(new ApiResponse(400, null, error.message));
    }

    const orderData = {
      orderType,
      customerInfo: customerId,
      selectedVegetables: processedVegetables,
      orderDate: new Date(),
      couponCode: validatedCouponCode,
      couponId,
      ...totals,
      orderId,
      paymentMethod: "COD",
      paymentStatus: "pending",
      orderStatus: "placed",
      stockUpdates,
      ...(orderType === "basket" && { selectedOffer: offerId }),
    };

    const order = await Order.create(orderData);

    if (couponId) {
      await incrementCouponUsage(couponId, customerId);
    }

    const populatedOrder = await Order.findById(order._id)
      .populate("customerInfo")
      .populate("selectedOffer")
      .populate("selectedVegetables.vegetable");

    return res.json(
      new ApiResponse(201, populatedOrder, "Order placed successfully with COD")
    );
  }

  // Online payment
  const amountInPaisa = Math.round(totals.totalAmount * 100);

  const razorpayOrder = await razorpay.orders.create({
    amount: amountInPaisa,
    currency: "INR",
    receipt: orderId,
    payment_capture: 1,
  });

  const orderData = {
    orderType,
    customerInfo: customerId,
    selectedVegetables: processedVegetables,
    orderId,
    couponCode: validatedCouponCode,
    couponId,
    ...totals,
    ...(orderType === "basket" && { selectedOffer: offerId }),
  };

  res.json(
    new ApiResponse(
      201,
      { razorpayOrder, orderData },
      "Razorpay order created. Complete payment to confirm order."
    )
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
    orderId,
    orderType,
    couponCode,
  } = req.body;

  // Validation
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing payment verification data"));
  }

  if (!customerInfo || !selectedVegetables || !orderId) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing order data"));
  }

  if (orderType === "basket" && !selectedOffer) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing offer for basket order"));
  }

  // Verify signature
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          "Payment verification failed - Invalid signature"
        )
      );
  }

  // Check duplicate
  const existingOrder = await Order.exists({
    razorpayPaymentId: razorpay_payment_id,
  });

  if (existingOrder) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "Order already exists for this payment")
      );
  }

  // Process order data
  const processed = await processOrderData(
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderType
  );

  if (processed.error) {
    return res.status(400).json(new ApiResponse(400, null, processed.error));
  }

  const { customerId, offerId, processedVegetables } = processed;

  // Validate and apply coupon
  let couponId = null;
  let couponDiscount = 0;
  let validatedCouponCode = null;
  let subtotalForCoupon = 0;

  if (orderType === "basket") {
    const offer = await Offer.findById(offerId).select("price").lean();
    if (!offer) {
      return res
        .status(404)
        .json(new ApiResponse(404, null, "Offer not found"));
    }
    subtotalForCoupon = offer.price;
  } else {
    subtotalForCoupon = processedVegetables.reduce(
      (sum, item) => sum + item.subtotal,
      0
    );
  }

  if (couponCode) {
    try {
      const couponValidation = await validateAndApplyCoupon(
        couponCode,
        subtotalForCoupon,
        customerId
      );
      couponId = couponValidation.couponId;
      couponDiscount = couponValidation.couponDiscount;
      validatedCouponCode = couponValidation.validatedCouponCode;
    } catch (error) {
      console.error("Coupon validation error during payment:", error.message);
    }
  }

  // Calculate totals
  let totals;
  if (orderType === "basket") {
    const offer = await Offer.findById(offerId).select("price").lean();
    const subtotalAfterDiscount = Math.max(0, offer.price - couponDiscount);
    totals = {
      vegetablesTotal: 0,
      offerPrice: offer.price,
      couponDiscount,
      subtotalAfterDiscount,
      deliveryCharges: DELIVERY_CHARGES_RUPEES,
      totalAmount: subtotalAfterDiscount + DELIVERY_CHARGES_RUPEES,
    };
  } else {
    totals = calculateOrderTotal(
      processedVegetables,
      null,
      orderType,
      couponDiscount
    );
  }

  // Deduct stock after successful payment
  let stockUpdates;
  try {
    stockUpdates = await deductVegetableStock(processedVegetables);
  } catch (error) {
    console.error("Stock deduction failed after payment:", error.message);
    return res
      .status(500)
      .json(
        new ApiResponse(
          500,
          null,
          "Payment successful but stock unavailable. Please contact support."
        )
      );
  }

  // Create order
  const orderData = {
    orderType,
    customerInfo: customerId,
    selectedVegetables: processedVegetables,
    orderDate: new Date(),
    couponCode: validatedCouponCode,
    couponId,
    ...totals,
    orderId,
    paymentMethod: "ONLINE",
    orderStatus: "placed",
    paymentStatus: "completed",
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    stockUpdates,
    ...(orderType === "basket" && { selectedOffer: offerId }),
  };

  const order = await Order.create(orderData);

  if (couponId) {
    await incrementCouponUsage(couponId, customerId);
  }

  const populatedOrder = await Order.findById(order._id)
    .populate("customerInfo")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable");

  res.json(
    new ApiResponse(
      200,
      populatedOrder,
      "Payment verified and order saved successfully"
    )
  );
});

export const deleteOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));
  }

  const result = await Order.findByIdAndDelete(id);

  if (!result) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  res.json(new ApiResponse(200, result, "Order deleted successfully"));
});

export const updateOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;

  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));
  }

  // Prevent updating sensitive fields
  delete updateData.razorpayOrderId;
  delete updateData.razorpayPaymentId;
  delete updateData.totalAmount;
  delete updateData.vegetablesTotal;
  delete updateData.offerPrice;
  delete updateData.orderType;
  delete updateData.couponDiscount;
  delete updateData.subtotalAfterDiscount;

  const order = await Order.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  })
    .populate("customerInfo")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable");

  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  res.json(new ApiResponse(200, order, "Order updated successfully"));
});

export const getRazorpayKey = asyncHandler(async (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID) {
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Razorpay key not configured"));
  }

  res.json(
    new ApiResponse(
      200,
      { key: process.env.RAZORPAY_KEY_ID },
      "Razorpay key fetched successfully"
    )
  );
});

export const calculatePrice = asyncHandler(async (req, res) => {
  const { items, couponCode } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Items array is required and cannot be empty");
  }

  let subtotal = 0;
  const calculatedItems = [];

  for (const item of items) {
    if (!item.vegetableId || !item.weight || !item.quantity) {
      throw new ApiError(
        400,
        "Each item must have vegetableId, weight, and quantity"
      );
    }

    if (item.quantity < 1) {
      throw new ApiError(400, "Quantity must be at least 1");
    }

    const vegetable = await Vegetable.findById(item.vegetableId).lean();
    if (!vegetable) {
      throw new ApiError(404, `Vegetable not found: ${item.vegetableId}`);
    }

    try {
      const priceInfo = getPrice(vegetable, item.weight, item.quantity);

      const calculatedItem = {
        vegetableId: item.vegetableId,
        name: vegetable.name,
        pricingType: vegetable.pricingType,
        quantity: item.quantity,
        pricePerUnit: priceInfo.pricePerUnit,
        subtotal: priceInfo.subtotal,
      };

      if (priceInfo.type === "set") {
        calculatedItem.weight = item.weight;
        calculatedItem.setLabel = priceInfo.label;
        calculatedItem.setQuantity = priceInfo.setQuantity;
        calculatedItem.setUnit = priceInfo.setUnit;
      } else {
        calculatedItem.weight = priceInfo.weight;
      }

      calculatedItems.push(calculatedItem);
      subtotal += priceInfo.subtotal;
    } catch (error) {
      throw new ApiError(
        400,
        `Error processing ${vegetable.name}: ${error.message}`
      );
    }
  }

  // Apply coupon discount (non-blocking)
  let couponDiscount = 0;
  let couponDetails = null;

  if (couponCode) {
    try {
      const couponValidation = await validateAndApplyCoupon(
        couponCode,
        subtotal,
        null
      );
      couponDiscount = couponValidation.couponDiscount;
      couponDetails = couponValidation.couponDetails;
    } catch (error) {
      couponDetails = {
        code: couponCode,
        applied: false,
        error: error.message,
      };
    }
  }

  // Calculate final amounts
  const subtotalAfterDiscount = Math.max(0, subtotal - couponDiscount);
  const freeDelivery = subtotalAfterDiscount > FREE_DELIVERY_THRESHOLD;
  const appliedDeliveryCharges = freeDelivery ? 0 : DELIVERY_CHARGES_RUPEES;
  const totalAmount = subtotalAfterDiscount + appliedDeliveryCharges;

  return res.json(
    new ApiResponse(
      200,
      {
        items: calculatedItems,
        coupon: couponDetails,
        summary: {
          subtotal,
          couponDiscount,
          subtotalAfterDiscount,
          deliveryCharges: appliedDeliveryCharges,
          freeDelivery,
          totalAmount,
        },
        timestamp: new Date().toISOString(),
      },
      "Price calculation successful"
    )
  );
});

export const validateCouponForBasket = asyncHandler(async (req, res) => {
  const { offerId, offerPrice, couponCode } = req.body;

  if (!offerId || !offerPrice) {
    throw new ApiError(400, "Offer ID and price are required");
  }

  if (!couponCode) {
    throw new ApiError(400, "Coupon code is required");
  }

  const offer = await Offer.findById(offerId).select("price").lean();
  if (!offer) {
    throw new ApiError(404, "Offer not found");
  }

  if (offer.price !== offerPrice) {
    throw new ApiError(400, "Offer price mismatch");
  }

  let couponDetails = null;
  let couponDiscount = 0;

  try {
    const coupon = await Coupon.findOne({
      code: couponCode.toUpperCase(),
      isActive: true,
    }).lean();

    if (!coupon) {
      throw new Error("Invalid coupon code");
    }

    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      throw new Error("Coupon has expired");
    }

    if (coupon.minOrderAmount && offerPrice < coupon.minOrderAmount) {
      throw new Error(
        `Minimum order amount of ₹${coupon.minOrderAmount} required for this coupon`
      );
    }

    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new Error("Coupon usage limit reached");
    }

    // Calculate discount inline
    couponDiscount =
      coupon.discountType === "percentage"
        ? Math.min(
            (offerPrice * coupon.discountValue) / 100,
            coupon.maxDiscount || Infinity
          )
        : Math.min(coupon.discountValue, offerPrice);

    couponDetails = {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount: couponDiscount,
    };
  } catch (error) {
    couponDetails = {
      code: couponCode,
      applied: false,
      error: error.message,
    };
  }

  const subtotalAfterDiscount = Math.max(0, offerPrice - couponDiscount);
  const totalAmount = subtotalAfterDiscount + DELIVERY_CHARGES_RUPEES;

  return res.json(
    new ApiResponse(
      200,
      {
        coupon: couponDetails,
        offerPrice,
        couponDiscount,
        subtotalAfterDiscount,
        deliveryCharges: DELIVERY_CHARGES_RUPEES,
        totalAmount,
      },
      "Coupon validation completed"
    )
  );
});

export const getOrdersByDateTimeRange = async (req, res) => {
  try {
    const { startDate, startTime, endDate, endTime } = req.query;

    if (!startDate || !startTime || !endDate || !endTime) {
      return res.status(400).json({
        success: false,
        message: "startDate, startTime, endDate, and endTime are required",
        example:
          "?startDate=2024-01-15&startTime=09:00&endDate=2024-01-20&endTime=18:00",
      });
    }

    const startDateTime = new Date(`${startDate}T${startTime}:00`);
    const endDateTime = new Date(`${endDate}T${endTime}:00`);

    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date or time format",
        example: "startDate: YYYY-MM-DD, startTime: HH:MM",
      });
    }

    if (startDateTime > endDateTime) {
      return res.status(400).json({
        success: false,
        message: "Start date-time cannot be after end date-time",
      });
    }

    // Use lean() for better performance
    const orders = await Order.find({
      orderDate: {
        $gte: startDateTime,
        $lte: endDateTime,
      },
      orderStatus: {
        $nin: ["delivered", "cancelled", "Delivered", "Cancelled"],
      },
    })
      .populate("customerInfo")
      .populate("selectedVegetables.vegetable")
      .lean();

    if (!orders || orders.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No orders found in the specified date-time range",
        data: {
          orders: [],
          totalOrders: 0,
          dateTimeRange: { start: startDateTime, end: endDateTime },
          summary: {
            totalOrders: 0,
            totalRevenue: 0,
            totalVegetablesWeightKg: 0,
            totalVegetablesPieces: 0,
            uniqueVegetables: 0,
          },
          vegetableData: {},
        },
      });
    }

    // Optimized calculation
    const vegData = {};
    let totalRevenue = 0;

    orders.forEach((order) => {
      totalRevenue += order.totalAmount || 0;

      order.selectedVegetables.forEach((item) => {
        const vegName = item.vegetable?.name || "Unknown";

        if (!vegData[vegName]) {
          vegData[vegName] = {
            totalWeightKg: 0,
            totalWeightG: 0,
            totalPieces: 0,
            totalBundles: 0,
            orders: 0,
            breakdown: [],
          };
        }

        const veg = vegData[vegName];
        const isSet = item.weight?.startsWith("set");

        let weightKg = 0;
        let pieces = 0;
        let bundles = 0;
        let display = "";

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
          weightKg = (WEIGHT_TO_KG[item.weight] || 0) * item.quantity;
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
      });
    });

    // Finalize calculations
    let totalWeightKg = 0;
    let totalPieces = 0;

    Object.keys(vegData).forEach((vegName) => {
      const veg = vegData[vegName];
      veg.totalWeightKg = Math.round(veg.totalWeightKg * 100) / 100;
      veg.totalWeightG = Math.round(veg.totalWeightKg * 1000);

      const parts = [];
      if (veg.totalWeightKg > 0) parts.push(`${veg.totalWeightKg}kg`);
      if (veg.totalPieces > 0) parts.push(`${veg.totalPieces} pieces`);
      if (veg.totalBundles > 0) parts.push(`${veg.totalBundles} bundles`);
      veg.summary = parts.join(", ") || "No quantities";

      totalWeightKg += veg.totalWeightKg;
      totalPieces += veg.totalPieces + veg.totalBundles;
    });

    const summary = {
      totalOrders: orders.length,
      totalRevenue,
      totalVegetablesWeightKg: Math.round(totalWeightKg * 100) / 100,
      totalVegetablesPieces: totalPieces,
      uniqueVegetables: Object.keys(vegData).length,
      dateRange: { from: startDate, to: endDate },
      timeRange: { from: startTime, to: endTime },
    };

    return res.status(200).json({
      success: true,
      message: "Orders retrieved successfully",
      data: {
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
    });
  } catch (error) {
    console.error("Error fetching orders by date-time range:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message,
    });
  }
};
