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

// Fixed: Moved weightMap to module scope and fixed function logic
const weightMap = {
  "1kg": "weight1kg",
  "500g": "weight500g",
  "250g": "weight250g",
  "100g": "weight100g",
};
function calculateKgFromWeight(weight, quantity) {
  const weightToKg = {
    "1kg": 1,
    "500g": 0.5,
    "250g": 0.25,
    "100g": 0.1,
  };
  
  return weightToKg[weight] * quantity;
}

/**
 * Deduct stock for ordered vegetables
 */
async function deductVegetableStock(selectedVegetables) {
  const stockUpdates = [];
  
  for (const item of selectedVegetables) {
    const kgToDeduct = calculateKgFromWeight(item.weight, item.quantity);
    
    const vegetable = await Vegetable.findById(item.vegetable);
    
    if (!vegetable) {
      throw new Error(`Vegetable not found: ${item.vegetable}`);
    }
    
    // Check if sufficient stock is available
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
    });
  }
  
  // If all checks pass, update all stocks
  for (const update of stockUpdates) {
    const updatedVeg = await Vegetable.findByIdAndUpdate(
      update.vegetableId,
      { $inc: { stockKg: -update.deducted } },
      { new: true }
    );
    
    // ✅ Auto-set outOfStock if below 0.25kg
    if (updatedVeg.stockKg < 0.25) {
      await Vegetable.findByIdAndUpdate(
        update.vegetableId,
        { $set: { outOfStock: true } }
      );
    }
  }
  
  return stockUpdates;
}

/**
 * Restore stock for cancelled vegetables
 */
async function restoreVegetableStock(selectedVegetables) {
  const stockUpdates = [];
  
  for (const item of selectedVegetables) {
    const kgToRestore = calculateKgFromWeight(item.weight, item.quantity);
    
    const vegetable = await Vegetable.findByIdAndUpdate(
      item.vegetable,
      { $inc: { stockKg: kgToRestore } },
      { new: true }
    );
    
    if (vegetable) {
      // ✅ Auto-set outOfStock to false if stock is restored above 0.25kg
      if (vegetable.stockKg >= 0.25) {
        await Vegetable.findByIdAndUpdate(
          item.vegetable,
          { $set: { outOfStock: false } }
        );
      }
      
      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        restored: kgToRestore,
        newStock: vegetable.stockKg,
      });
    }
  }
  
  return stockUpdates;
}

function getPriceForWeight(vegetable, weight) {
  const priceKey = weightMap[weight];
  if (!priceKey || !vegetable.prices?.[priceKey]) {
    throw new Error(`Invalid weight: ${weight}`);
  }
  return vegetable.prices[priceKey];
}

async function processCustomer(customerInfo) {
  if (typeof customerInfo === "string") {
    const customer = await Customer.findById(customerInfo);
    if (!customer) throw new Error("Customer not found");
    return customerInfo;
  }

  if (customerInfo._id) {
    return customerInfo._id;
  }

  if (!customerInfo.mobile || !customerInfo.name) {
    throw new Error("Customer name and mobile are required");
  }

  const updateData = {
    name: customerInfo.name,
    mobile: customerInfo.mobile,
  };

  if (customerInfo.city) updateData.city = customerInfo.city;
  if (customerInfo.area) updateData.area = customerInfo.area;
  if (customerInfo.email) updateData.email = customerInfo.email;
  if (customerInfo.address) updateData.address = customerInfo.address;

  try {
    let customer = await Customer.findOne({ mobile: customerInfo.mobile });

    if (customer) {
      customer = await Customer.findByIdAndUpdate(
        customer._id,
        { $set: updateData },
        { new: true, runValidators: true }
      );
    } else {
      if (customerInfo.email) {
        const existingEmailCustomer = await Customer.findOne({
          email: customerInfo.email,
        });

        if (existingEmailCustomer) {
          customer = await Customer.findByIdAndUpdate(
            existingEmailCustomer._id,
            { $set: updateData },
            { new: true, runValidators: true }
          );
        } else {
          customer = await Customer.create(updateData);
        }
      } else {
        customer = await Customer.create(updateData);
      }
    }

    return customer._id;
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];

      if (field === "email" && customerInfo.email) {
        const customer = await Customer.findOneAndUpdate(
          { email: customerInfo.email },
          { $set: updateData },
          { new: true, runValidators: true }
        );
        return customer._id;
      } else if (field === "mobile") {
        const customer = await Customer.findOneAndUpdate(
          { mobile: customerInfo.mobile },
          { $set: updateData },
          { new: true, runValidators: true }
        );
        return customer._id;
      }
    }
    throw error;
  }
}

async function processOffer(selectedOffer) {
  if (!selectedOffer) return null;

  let query = {};

  if (typeof selectedOffer === "string") {
    if (!selectedOffer.match(/^[0-9a-fA-F]{24}$/)) {
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

  const offer = await Offer.findOne(query);
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

  const isObjectId = uniqueVegIds[0].match(/^[0-9a-fA-F]{24}$/);

  const vegetables = await Vegetable.find(
    isObjectId
      ? { _id: { $in: uniqueVegIds } }
      : {
          $or: [
            { name: { $in: uniqueVegIds } },
            { _id: { $in: uniqueVegIds } },
          ],
        }
  );

  if (vegetables.length !== uniqueVegIds.length) {
    const foundIds = vegetables.map((v) => v._id.toString());
    const missingIds = uniqueVegIds.filter(
      (id) => !foundIds.includes(id) && !vegetables.find((v) => v.name === id)
    );
    throw new Error(
      `Some vegetables not found. Expected ${uniqueVegIds.length}, found ${vegetables.length}. Missing IDs: ${missingIds.join(", ")}`
    );
  }

  const vegMap = new Map();
  vegetables.forEach((veg) => {
    vegMap.set(veg._id.toString(), veg);
    vegMap.set(veg.name, veg);
  });

  const groupedItems = new Map();

  selectedVegetables.forEach((item) => {
    const identifier = getVegetableIdentifier(item);
    const vegetable = vegMap.get(identifier);

    if (!vegetable) {
      throw new Error(`Vegetable not found: ${identifier}`);
    }

    const weight = (typeof item === "object" && item?.weight) || "1kg";
    const quantity = (typeof item === "object" && item?.quantity) || 1;

    const validWeights = ["1kg", "500g", "250g", "100g"];
    if (!validWeights.includes(weight)) {
      throw new Error(
        `Invalid weight: ${weight}. Must be one of: ${validWeights.join(", ")}`
      );
    }

    const groupKey = `${vegetable._id.toString()}_${weight}`;

    if (groupedItems.has(groupKey)) {
      const existing = groupedItems.get(groupKey);
      existing.quantity += quantity;
      existing.subtotal = existing.pricePerUnit * existing.quantity;
    } else {
      const price = getPriceForWeight(vegetable, weight);
      groupedItems.set(groupKey, {
        vegetable: vegetable._id,
        weight,
        quantity,
        pricePerUnit: price,
        subtotal: price * quantity,
        isFromBasket,
      });
    }
  });

  return Array.from(groupedItems.values());
}

async function processOrderData(
  customerInfo,
  selectedOffer,
  selectedVegetables,
  orderType = "custom"
) {
  try {
    const isBasketOrder = orderType === "basket";
    const customerId = await processCustomer(customerInfo);
    const offerId = isBasketOrder ? await processOffer(selectedOffer) : null;
    const processedVegetables = await processVegetables(
      selectedVegetables,
      isBasketOrder
    );

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

  const deliveryChargesInRupees = DELIVERY_CHARGES / 100;

  let totalAmount;
  let finalOfferPrice = 0;
  let appliedDeliveryCharges = 0;
  let subtotalAfterDiscount = 0;

  if (orderType === "basket") {
    if (!offerPrice) {
      throw new Error("Offer price is required for basket orders");
    }

    finalOfferPrice = offerPrice;
    subtotalAfterDiscount = Math.max(0, offerPrice - couponDiscount);
    appliedDeliveryCharges = deliveryChargesInRupees;
    totalAmount = subtotalAfterDiscount + deliveryChargesInRupees;
  } else {
    subtotalAfterDiscount = Math.max(0, vegetablesTotal - couponDiscount);

    if (subtotalAfterDiscount > 250) {
      appliedDeliveryCharges = 0;
      totalAmount = subtotalAfterDiscount;
    } else {
      appliedDeliveryCharges = deliveryChargesInRupees;
      totalAmount = subtotalAfterDiscount + deliveryChargesInRupees;
    }
  }

  return {
    vegetablesTotal,
    offerPrice: finalOfferPrice,
    couponDiscount,
    subtotalAfterDiscount,
    deliveryCharges: appliedDeliveryCharges,
    totalAmount,
  };
}

// Fixed: Centralized coupon validation function
async function validateAndApplyCoupon(couponCode, subtotal, customerId = null) {
  if (!couponCode) {
    return {
      couponId: null,
      couponDiscount: 0,
      validatedCouponCode: null,
      couponDetails: null,
    };
  }

  try {
    const coupon = await Coupon.findOne({
      code: couponCode.toUpperCase(),
      isActive: true,
    });

    if (!coupon) {
      throw new Error("Invalid coupon code");
    }

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

    // Check per-user limit if customerId is provided
    if (customerId && coupon.perUserLimit) {
      const userUsageCount =
        coupon.usedBy?.filter((id) => id.toString() === customerId.toString())
          .length || 0;
      if (userUsageCount >= coupon.perUserLimit) {
        throw new Error("You have reached the usage limit for this coupon");
      }
    }

    // Calculate discount
    const couponDiscount = coupon.calculateDiscount(subtotal);

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
  } catch (error) {
    throw error;
  }
}

export const calculateTodayOrderTotal = asyncHandler(async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const count = await Order.countDocuments({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    });

    res.json(
      new ApiResponse(
        200,
        { count },
        "Today's order count fetched successfully"
      )
    );
  } catch (error) {
    throw new ApiError(
      500,
      error.message || "Failed to calculate today's order total"
    );
  }
});

export const getOrders = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.status) filter.paymentStatus = req.query.status;
  if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
  if (req.query.orderType) filter.orderType = req.query.orderType;

  const totalOrders = await Order.countDocuments(filter);

  const orders = await Order.find(filter)
    .populate("customerInfo")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json(
    new ApiResponse(
      200,
      {
        orders,
      },
      "Orders fetched successfully"
    )
  );
});

export const getOrderById = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  if (!orderId.match(/^ORD\d{11}$/)) {
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));
  }

  const order = await Order.findOne({ orderId: orderId })
    .populate("customerInfo")
    .populate("selectedOffer")
    .populate("selectedVegetables.vegetable");

  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  res.json(new ApiResponse(200, order, "Order fetched successfully"));
});

export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { orderStatus } = req.body;

  const validStatuses = [
    "placed",
    "processed",
    "shipped",
    "delivered",
    "cancelled",
  ];

  if (!orderStatus || !validStatuses.includes(orderStatus)) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          `Invalid order status. Must be one of: ${validStatuses.join(", ")}`
        )
      );
  }

  // Get the current order
  const currentOrder = await Order.findById(_id);
  
  if (!currentOrder) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  // ✅ If order is being cancelled, restore stock
  if (orderStatus === "cancelled" && currentOrder.orderStatus !== "cancelled") {
    try {
      const stockUpdates = await restoreVegetableStock(
        currentOrder.selectedVegetables
      );
      console.log("Stock restored for cancelled order:", stockUpdates);
    } catch (error) {
      console.error("Error restoring stock:", error.message);
      // Continue with cancellation even if stock restore fails
    }
  }

  // Update order status
  const order = await Order.findByIdAndUpdate(
    _id,
    { orderStatus },
    {
      new: true,
      runValidators: true,
    }
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

  if (
    !selectedVegetables ||
    !Array.isArray(selectedVegetables) ||
    selectedVegetables.length === 0
  ) {
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

  if (!paymentMethod || !["COD", "ONLINE"].includes(paymentMethod)) {
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

  // Validate and apply coupon
  let couponId = null;
  let couponDiscount = 0;
  let validatedCouponCode = null;
  let subtotalForCoupon = 0;

  if (orderType === "basket") {
    const offer = await Offer.findById(offerId);
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
      return res.status(400).json(new ApiResponse(400, null, error.message));
    }
  }

  // Calculate totals
  let totals;
  if (orderType === "basket") {
    const offer = await Offer.findById(offerId);
    const deliveryChargesInRupees = DELIVERY_CHARGES / 100;
    const subtotalAfterDiscount = Math.max(0, offer.price - couponDiscount);
    
    totals = {
      vegetablesTotal: 0,
      offerPrice: offer.price,
      couponDiscount,
      subtotalAfterDiscount,
      deliveryCharges: deliveryChargesInRupees,
      totalAmount: subtotalAfterDiscount + deliveryChargesInRupees,
    };
  } else {
    totals = calculateOrderTotal(
      processedVegetables,
      null,
      orderType,
      couponDiscount
    );
  }

  // Handle COD payment
  if (paymentMethod === "COD") {
    // ✅ Deduct stock before creating order
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
      stockUpdates, // Store stock update info
    };

    if (orderType === "basket") {
      orderData.selectedOffer = offerId;
    }

    const order = await Order.create(orderData);

    // Increment coupon usage
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

  // Handle online payment - Don't deduct stock yet, wait for payment verification
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
  };

  if (orderType === "basket") {
    orderData.selectedOffer = offerId;
  }

  res.json(
    new ApiResponse(
      201,
      {
        razorpayOrder,
        orderData,
      },
      "Razorpay order created. Complete payment to confirm order."
    )
  );
});

// ✅ UPDATED: Modified verifyPayment to handle basket orders correctly
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

  // Check for duplicate payment
  const existingOrder = await Order.findOne({
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
    const offer = await Offer.findById(offerId);
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
    const offer = await Offer.findById(offerId);
    const deliveryChargesInRupees = DELIVERY_CHARGES / 100;
    const subtotalAfterDiscount = Math.max(0, offer.price - couponDiscount);
    
    totals = {
      vegetablesTotal: 0,
      offerPrice: offer.price,
      couponDiscount,
      subtotalAfterDiscount,
      deliveryCharges: deliveryChargesInRupees,
      totalAmount: subtotalAfterDiscount + deliveryChargesInRupees,
    };
  } else {
    totals = calculateOrderTotal(
      processedVegetables,
      null,
      orderType,
      couponDiscount
    );
  }

  // ✅ Deduct stock after successful payment
  let stockUpdates;
  try {
    stockUpdates = await deductVegetableStock(processedVegetables);
  } catch (error) {
    // Payment succeeded but stock insufficient - critical situation
    // You might want to handle this differently (e.g., notify admin, refund)
    console.error("Stock deduction failed after payment:", error.message);
    return res.status(500).json(
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
    stockUpdates, // Store stock update info
  };

  if (orderType === "basket") {
    orderData.selectedOffer = offerId;
  }

  const order = await Order.create(orderData);

  // Increment coupon usage
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

  if (!id.match(/^[0-9a-fA-F]{24}$/)) {
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

  if (!id.match(/^[0-9a-fA-F]{24}$/)) {
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
  // console.log({ items, couponCode });

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Items array is required and cannot be empty");
  }

  let subtotal = 0;
  const calculatedItems = [];

  // Calculate items subtotal
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

    const vegetable = await Vegetable.findById(item.vegetableId);
    if (!vegetable) {
      throw new ApiError(404, `Vegetable not found: ${item.vegetableId}`);
    }

    const pricePerUnit = getPriceForWeight(vegetable, item.weight);
    const itemSubtotal = pricePerUnit * item.quantity;

    calculatedItems.push({
      vegetableId: item.vegetableId,
      name: vegetable.name,
      weight: item.weight,
      quantity: item.quantity,
      pricePerUnit,
      subtotal: itemSubtotal,
    });

    subtotal += itemSubtotal;
  }

  // Apply coupon discount (non-blocking)
  let couponDiscount = 0;
  let couponDetails = null;

  if (couponCode) {
    try {
      const couponValidation = await validateAndApplyCoupon(
        couponCode,
        subtotal,
        null // No customer ID for price calculation
      );

      couponDiscount = couponValidation.couponDiscount;
      couponDetails = couponValidation.couponDetails;
    } catch (error) {
      // Return error details for invalid coupon
      couponDetails = {
        code: couponCode,
        applied: false,
        error: error.message,
      };
    }
  }

  // Calculate final amounts
  const subtotalAfterDiscount = Math.max(0, subtotal - couponDiscount);
  const deliveryChargesInRupees = DELIVERY_CHARGES / 100;

  let appliedDeliveryCharges = 0;
  let freeDelivery = false;

  if (subtotalAfterDiscount > 250) {
    appliedDeliveryCharges = 0;
    freeDelivery = true;
  } else {
    appliedDeliveryCharges = deliveryChargesInRupees;
  }

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

  // Validation
  if (!offerId || !offerPrice) {
    throw new ApiError(400, "Offer ID and price are required");
  }

  if (!couponCode) {
    throw new ApiError(400, "Coupon code is required");
  }

  // Verify offer exists
  const offer = await Offer.findById(offerId);
  if (!offer) {
    throw new ApiError(404, "Offer not found");
  }

  // Validate offer price matches
  if (offer.price !== offerPrice) {
    throw new ApiError(400, "Offer price mismatch");
  }

  let couponDetails = null;
  let couponDiscount = 0;

  try {
    // Find and validate coupon
    const coupon = await Coupon.findOne({
      code: couponCode.toUpperCase(),
      isActive: true,
    });

    if (!coupon) {
      throw new Error("Invalid coupon code");
    }

    // Check expiry
    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      throw new Error("Coupon has expired");
    }

    // Check minimum order amount (against offer price)
    if (coupon.minOrderAmount && offerPrice < coupon.minOrderAmount) {
      throw new Error(
        `Minimum order amount of ₹${coupon.minOrderAmount} required for this coupon`
      );
    }

    // Check usage limits
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new Error("Coupon usage limit reached");
    }

    // Calculate discount on offer price
    couponDiscount = coupon.calculateDiscount(offerPrice);

    couponDetails = {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount: couponDiscount,
    };
  } catch (error) {
    // Return error in response, not as HTTP error
    couponDetails = {
      code: couponCode,
      applied: false,
      error: error.message,
    };
  }

  // Calculate final amounts
  const subtotalAfterDiscount = Math.max(0, offerPrice - couponDiscount);

  // Basket orders always have fixed delivery charge of ₹20
  const deliveryChargesInRupees = DELIVERY_CHARGES / 100;
  const totalAmount = subtotalAfterDiscount + deliveryChargesInRupees;

  return res.json(
    new ApiResponse(
      200,
      {
        coupon: couponDetails,
        offerPrice,
        couponDiscount,
        subtotalAfterDiscount,
        deliveryCharges: deliveryChargesInRupees,
        totalAmount,
      },
      "Coupon validation completed"
    )
  );
});
