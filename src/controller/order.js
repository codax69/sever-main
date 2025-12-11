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
// PRICING HELPER FUNCTIONS
// ============================================================================

/**
 * Get price for set-based pricing
 */
function getPriceForSet(vegetable, setIndex) {
  if (!vegetable.setPricing?.enabled || !vegetable.setPricing?.sets) {
    throw new Error(
      `Vegetable ${vegetable.name} does not have set pricing enabled`
    );
  }

  const setOption = vegetable.setPricing.sets[setIndex];

  if (!setOption) {
    throw new Error(
      `Invalid set index: ${setIndex}. Available sets: 0-${vegetable.setPricing.sets.length - 1}`
    );
  }

  return {
    price: setOption.price,
    quantity: setOption.quantity,
    unit: setOption.unit,
    label: `${setOption.quantity} ${setOption.unit}`,
  };
}

/**
 * Get price for weight-based pricing
 */
function getPriceForWeight(vegetable, weight) {
  const weightMap = {
    "1kg": "weight1kg",
    "500g": "weight500g",
    "250g": "weight250g",
    "100g": "weight100g",
  };

  const priceKey = weightMap[weight];
  if (!priceKey || !vegetable.prices?.[priceKey]) {
    throw new Error(
      `Invalid weight: ${weight}. Must be one of: 1kg, 500g, 250g, 100g`
    );
  }
  return vegetable.prices[priceKey];
}

/**
 * Get price based on vegetable's pricing type
 */
function getPrice(vegetable, weightOrSet, quantity = 1) {
  if (vegetable.pricingType === "set" || vegetable.setPricing?.enabled) {
    // Handle set-based pricing
    const setIndex = weightOrSet.startsWith("set")
      ? parseInt(weightOrSet.replace("set", ""))
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
  } else {
    // Handle weight-based pricing
    const pricePerUnit = getPriceForWeight(vegetable, weightOrSet);

    return {
      type: "weight",
      pricePerUnit,
      subtotal: pricePerUnit * quantity,
      weight: weightOrSet,
    };
  }
}

// ============================================================================
// STOCK CALCULATION FUNCTIONS
// ============================================================================

/**
 * Calculate kg from weight for stock deduction (weight-based only)
 */
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
 * Calculate pieces from set for stock deduction (set-based only)
 */
function calculatePiecesFromSet(vegetable, setIndex, quantity) {
  const setOption = vegetable.setPricing.sets[setIndex];
  if (!setOption) {
    throw new Error(`Invalid set index: ${setIndex}`);
  }

  return setOption.quantity * quantity;
}

/**
 * Deduct stock for ordered vegetables (handles both weight and set pricing)
 */
async function deductVegetableStock(selectedVegetables) {
  const stockUpdates = [];

  for (const item of selectedVegetables) {
    const vegetable = await Vegetable.findById(item.vegetable);

    if (!vegetable) {
      throw new Error(`Vegetable not found: ${item.vegetable}`);
    }

    if (vegetable.pricingType === "set" || vegetable.setPricing?.enabled) {
      // Handle set-based stock
      const setIndex =
        item.setIndex ?? parseInt(item.weight?.replace("set", "") || "0");
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
    } else {
      // Handle weight-based stock
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
    }
  }

  // If all checks pass, update all stocks
  for (const update of stockUpdates) {
    if (update.type === "pieces") {
      const updatedVeg = await Vegetable.findByIdAndUpdate(
        update.vegetableId,
        { $inc: { stockPieces: -update.deducted } },
        { new: true }
      );

      if (updatedVeg.stockPieces <= 0) {
        await Vegetable.findByIdAndUpdate(update.vegetableId, {
          $set: { outOfStock: true },
        });
      }
    } else {
      const updatedVeg = await Vegetable.findByIdAndUpdate(
        update.vegetableId,
        { $inc: { stockKg: -update.deducted } },
        { new: true }
      );

      if (updatedVeg.stockKg < 0.25) {
        await Vegetable.findByIdAndUpdate(update.vegetableId, {
          $set: { outOfStock: true },
        });
      }
    }
  }

  return stockUpdates;
}

/**
 * Restore stock for cancelled vegetables (handles both weight and set pricing)
 */
async function restoreVegetableStock(selectedVegetables) {
  const stockUpdates = [];

  for (const item of selectedVegetables) {
    const vegetable = await Vegetable.findById(item.vegetable);

    if (!vegetable) continue;

    if (vegetable.pricingType === "set" || vegetable.setPricing?.enabled) {
      // Handle set-based stock restoration
      const setIndex =
        item.setIndex ?? parseInt(item.weight?.replace("set", "") || "0");
      const piecesToRestore = calculatePiecesFromSet(
        vegetable,
        setIndex,
        item.quantity
      );

      const updatedVeg = await Vegetable.findByIdAndUpdate(
        item.vegetable,
        { $inc: { stockPieces: piecesToRestore } },
        { new: true }
      );

      if (updatedVeg && updatedVeg.stockPieces > 0) {
        await Vegetable.findByIdAndUpdate(item.vegetable, {
          $set: { outOfStock: false },
        });
      }

      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        restored: piecesToRestore,
        newStock: updatedVeg.stockPieces,
        type: "pieces",
      });
    } else {
      // Handle weight-based stock restoration
      const kgToRestore = calculateKgFromWeight(item.weight, item.quantity);

      const updatedVeg = await Vegetable.findByIdAndUpdate(
        item.vegetable,
        { $inc: { stockKg: kgToRestore } },
        { new: true }
      );

      if (updatedVeg && updatedVeg.stockKg >= 0.25) {
        await Vegetable.findByIdAndUpdate(item.vegetable, {
          $set: { outOfStock: false },
        });
      }

      stockUpdates.push({
        vegetableId: item.vegetable,
        vegetableName: vegetable.name,
        restored: kgToRestore,
        newStock: updatedVeg.stockKg,
        type: "kg",
      });
    }
  }

  return stockUpdates;
}

// ============================================================================
// ORDER PROCESSING HELPER FUNCTIONS
// ============================================================================

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

/**
 * Process vegetables for order (handles both weight and set pricing)
 */
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

    const weightOrSet = (typeof item === "object" && item?.weight) || "1kg";
    const quantity = (typeof item === "object" && item?.quantity) || 1;

    const groupKey = `${vegetable._id.toString()}_${weightOrSet}`;

    if (groupedItems.has(groupKey)) {
      const existing = groupedItems.get(groupKey);
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
        itemData.weight = weightOrSet; // Store original "set0", "set1", etc.
        itemData.setIndex = priceInfo.setIndex;
        itemData.setLabel = priceInfo.label;
        itemData.setQuantity = priceInfo.setQuantity;
        itemData.setUnit = priceInfo.setUnit;
      } else {
        itemData.weight = priceInfo.weight;
      }

      groupedItems.set(groupKey, itemData);
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

// ============================================================================
// EXPORTED CONTROLLER FUNCTIONS
// ============================================================================

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
  const page = parseInt(req.query.page);
  const limit = parseInt(req.query.limit);
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

  // If order is being cancelled, restore stock
  if (orderStatus === "cancelled" && currentOrder.orderStatus !== "cancelled") {
    try {
      const stockUpdates = await restoreVegetableStock(
        currentOrder.selectedVegetables
      );
      // console.log("Stock restored for cancelled order:", stockUpdates);
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
    // Deduct stock before creating order
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

  // Deduct stock after successful payment
  let stockUpdates;
  try {
    stockUpdates = await deductVegetableStock(processedVegetables);
  } catch (error) {
    // Payment succeeded but stock insufficient - critical situation
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

    const vegetable = await Vegetable.findById(item.vegetableId);
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
        calculatedItem.weight = item.weight; // "set0", "set1", etc.
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

  // Basket orders always have fixed delivery charge
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
export const getOrdersByDateTimeRange = async (req, res) => {
  try {
    const { startDate, startTime, endDate, endTime } = req.query;

    // console.log('Received params:', { startDate, startTime, endDate, endTime });

    // Validate required parameters
    if (!startDate || !startTime || !endDate || !endTime) {
      return res.status(400).json({
        success: false,
        message: "startDate, startTime, endDate, and endTime are required",
        example: "?startDate=2024-01-15&startTime=09:00&endDate=2024-01-20&endTime=18:00"
      });
    }

    // Create start and end datetime objects
    // Format: YYYY-MM-DDTHH:MM:SS
    const startDateTime = new Date(`${startDate}T${startTime}:00`);
    const endDateTime = new Date(`${endDate}T${endTime}:00`);

    // console.log('DateTime range:', { startDateTime, endDateTime });

    // Validate dates
    if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date or time format",
        example: "startDate: YYYY-MM-DD, startTime: HH:MM"
      });
    }

    if (startDateTime > endDateTime) {
      return res.status(400).json({
        success: false,
        message: "Start date-time cannot be after end date-time"
      });
    }

    // Fetch orders within the date-time range
    // Exclude orders that are delivered or cancelled
    const orders = await Order.find({
      orderDate: {
        $gte: startDateTime,
        $lte: endDateTime
      },
      orderStatus: {
        $nin: ['delivered', 'cancelled', 'Delivered', 'Cancelled']
      }
    }).populate('customerInfo').populate('selectedVegetables.vegetable');

    // console.log(`Found ${orders.length} orders`);

    if (!orders || orders.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No orders found in the specified date-time range",
        data: {
          orders: [],
          totalOrders: 0,
          dateTimeRange: {
            start: startDateTime,
            end: endDateTime
          },
          summary: {
            totalOrders: 0,
            totalRevenue: 0,
            totalVegetablesWeight: 0,
            uniqueVegetables: 0
          },
          vegetableWeights: {}
        }
      });
    }

    // Calculate vegetable weights
    const vegetableWeights = {};
    
    orders.forEach(order => {
      order.selectedVegetables.forEach(item => {
        const vegetableName = item.vegetable?.name || 'Unknown Vegetable';
        const weight = item.weight; // e.g., "1kg", "500g", "250g"
        const quantity = item.quantity;

        // Convert weight to kg
        let weightInKg = 0;
        if (weight.includes('kg')) {
          weightInKg = parseFloat(weight) * quantity;
        } else if (weight.includes('g')) {
          weightInKg = (parseFloat(weight) / 1000) * quantity;
        }

        // Initialize vegetable entry if it doesn't exist
        if (!vegetableWeights[vegetableName]) {
          vegetableWeights[vegetableName] = {
            totalWeightKg: 0,
            totalWeightG: 0,
            orders: 0,
            breakdown: []
          };
        }

        // Add to total weight
        vegetableWeights[vegetableName].totalWeightKg += weightInKg;
        vegetableWeights[vegetableName].orders += 1;
        
        // Add breakdown details
        vegetableWeights[vegetableName].breakdown.push({
          orderId: order.orderId,
          weight: weight,
          quantity: quantity,
          totalWeight: `${weightInKg}kg`,
          customerName: order.customerInfo?.name || 'Unknown',
          orderDate: order.orderDate
        });
      });
    });

    // Convert kg to g for better readability
    Object.keys(vegetableWeights).forEach(vegName => {
      const totalKg = vegetableWeights[vegName].totalWeightKg;
      vegetableWeights[vegName].totalWeightG = Math.round(totalKg * 1000);
      vegetableWeights[vegName].totalWeightKg = Math.round(totalKg * 100) / 100; // Round to 2 decimals
    });

    // Calculate summary statistics
    const summary = {
      totalOrders: orders.length,
      totalRevenue: orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0),
      totalVegetablesWeight: Object.values(vegetableWeights).reduce(
        (sum, veg) => sum + veg.totalWeightKg, 0
      ),
      uniqueVegetables: Object.keys(vegetableWeights).length,
      dateRange: {
        from: startDate,
        to: endDate
      },
      timeRange: {
        from: startTime,
        to: endTime
      }
    };

    return res.status(200).json({
      success: true,
      message: "Orders retrieved successfully",
      data: {
        dateTimeRange: {
          start: startDateTime,
          end: endDateTime
        },
        summary,
        vegetableWeights,
        orders: orders.map(order => ({
          _id: order._id,
          orderId: order.orderId,
          customerName: order.customerInfo?.name,
          orderDate: order.orderDate,
          totalAmount: order.totalAmount,
          paymentStatus: order.paymentStatus,
          orderStatus: order.orderStatus,
          vegetables: order.selectedVegetables.map(item => ({
            name: item.vegetable?.name || 'Unknown',
            weight: item.weight,
            quantity: item.quantity,
            subtotal: item.subtotal
          }))
        }))
      }
    });

  } catch (error) {
    console.error("Error fetching orders by date-time range:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
      error: error.message
    });
  }
};