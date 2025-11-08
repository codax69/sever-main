import Order from "../Model/order.js";
import Customer from "../Model/customer.js";
import Vegetable from "../Model/vegetable.js";
import Offer from "../Model/offer.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import "dotenv/config";
import { DELIVERY_CHARGES } from "../../const.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

function getPriceForWeight(vegetable, weight) {
  const weightMap = {
    "1kg": "weight1kg",
    "500g": "weight500g",
    "250g": "weight250g",
    "100g": "weight100g",
  };

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

  if (customerInfo.email) {
    updateData.email = customerInfo.email;
  }

  if (customerInfo.address) {
    updateData.address = customerInfo.address;
  }

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

  const identifiers = selectedVegetables
    .map(getVegetableIdentifier)
    .filter(Boolean);

  if (identifiers.length === 0) {
    throw new Error("No valid vegetable identifiers found");
  }

  const isObjectId = identifiers[0].match(/^[0-9a-fA-F]{24}$/);

  const vegetables = await Vegetable.find(
    isObjectId
      ? { _id: { $in: identifiers } }
      : { $or: [{ name: { $in: identifiers } }, { _id: { $in: identifiers } }] }
  );

  if (vegetables.length !== identifiers.length) {
    throw new Error(
      `Some vegetables not found. Expected ${identifiers.length}, found ${vegetables.length}`
    );
  }

  const vegMap = new Map();
  vegetables.forEach((veg) => {
    vegMap.set(veg._id.toString(), veg);
    vegMap.set(veg.name, veg);
  });

  const processedVegetables = selectedVegetables.map((item) => {
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

    const price = getPriceForWeight(vegetable, weight);

    return {
      vegetable: vegetable._id,
      weight,
      quantity,
      pricePerUnit: price,
      subtotal: price * quantity,
      isFromBasket,
    };
  });

  return processedVegetables;
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
  orderType = "custom"
) {
  const vegetablesTotal = processedVegetables.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  const deliveryChargesInRupees = DELIVERY_CHARGES / 100;

  let totalAmount;
  let finalOfferPrice = 0;
  let appliedDeliveryCharges = 0;

  if (orderType === "basket") {
    if (!offerPrice) {
      throw new Error("Offer price is required for basket orders");
    }

    finalOfferPrice = offerPrice;
    appliedDeliveryCharges = deliveryChargesInRupees;
    totalAmount = offerPrice + deliveryChargesInRupees;

    // console.log("Basket Order - Offer Price:", offerPrice);
    // console.log("Basket Order - Delivery Charges:", deliveryChargesInRupees);
    // console.log("Basket Order - Total Amount:", totalAmount);
  } else {
    if (vegetablesTotal > 250) {
      appliedDeliveryCharges = 0;
      totalAmount = vegetablesTotal;
      // console.log("Custom Order - Free Delivery");
    } else {
      appliedDeliveryCharges = deliveryChargesInRupees;
      totalAmount = vegetablesTotal + deliveryChargesInRupees;
      // console.log("Custom Order - Delivery Charges Applied");
    }

    // console.log("Custom Order - Vegetables Total:", vegetablesTotal);
    // console.log("Custom Order - Total Amount:", totalAmount);
  }

  return {
    vegetablesTotal,
    offerPrice: finalOfferPrice,
    deliveryCharges: appliedDeliveryCharges,
    totalAmount,
  };
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
      error.message,
      "Failed to calculate today's order total"
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

export const addOrder = asyncHandler(async (req, res) => {
  const {
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderId,
    paymentMethod,
    orderType,
  } = req.body;
  // console.log("Add Order Request Body:", {
  //   customerInfo,
  //   selectedOffer,
  //   selectedVegetables,
  //   orderId,
  //   paymentMethod,
  //   orderType,
  // });
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

  let offerPrice = null;
  if (orderType === "basket") {
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res
        .status(404)
        .json(new ApiResponse(404, null, "Offer not found"));
    }
    offerPrice = offer.price;
  }

  const totals = calculateOrderTotal(
    processedVegetables,
    offerPrice,
    orderType
  );

  if (paymentMethod === "COD") {
    const orderData = {
      orderType,
      customerInfo: customerId,
      selectedVegetables: processedVegetables,
      orderDate: new Date(),
      totalAmount: totals.totalAmount,
      vegetablesTotal: totals.vegetablesTotal,
      offerPrice: totals.offerPrice,
      deliveryCharges: totals.deliveryCharges,
      orderId,
      paymentMethod: "COD",
      paymentStatus: "pending",
      orderStatus: "placed",
    };

    if (orderType === "basket") {
      orderData.selectedOffer = offerId;
    }

    const order = await Order.create(orderData);

    const populatedOrder = await Order.findById(order._id)
      .populate("customerInfo")
      .populate("selectedOffer")
      .populate("selectedVegetables.vegetable");

    return res.json(
      new ApiResponse(201, populatedOrder, "Order placed successfully with COD")
    );
  }

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
  } = req.body;
  // console.log(orderType);
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

  let offerPrice = null;
  if (orderType === "basket") {
    const offer = await Offer.findById(offerId);
    if (!offer) {
      return res
        .status(404)
        .json(new ApiResponse(404, null, "Offer not found"));
    }
    offerPrice = offer.price;
  }

  const totals = calculateOrderTotal(
    processedVegetables,
    offerPrice,
    orderType
  );

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

  const orderData = {
    orderType,
    customerInfo: customerId,
    selectedVegetables: processedVegetables,
    orderDate: new Date(),
    totalAmount: totals.totalAmount,
    vegetablesTotal: totals.vegetablesTotal,
    offerPrice: totals.offerPrice,
    deliveryCharges: totals.deliveryCharges,
    orderId,
    paymentMethod: "ONLINE",
    orderStatus: "placed",
    paymentStatus: "completed",
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
  };

  if (orderType === "basket") {
    orderData.selectedOffer = offerId;
  }

  const order = await Order.create(orderData);

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

  delete updateData.razorpayOrderId;
  delete updateData.razorpayPaymentId;
  delete updateData.totalAmount;
  delete updateData.vegetablesTotal;
  delete updateData.offerPrice;
  delete updateData.orderType;

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
  const { items } = req.body;
  // console.log(items);
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

  const deliveryChargesInRupees = DELIVERY_CHARGES / 100;
  let appliedDeliveryCharges = 0;
  let freeDelivery = false;

  if (subtotal > 250) {
    appliedDeliveryCharges = 0;
    freeDelivery = true;
  } else {
    appliedDeliveryCharges = deliveryChargesInRupees;
  }

  const totalAmount = subtotal + appliedDeliveryCharges;

  return res.json(
    new ApiResponse(
      200,
      {
        items: calculatedItems,
        summary: {
          subtotal,
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
export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { orderStatus } = req.body;
  // console.log(orderStatus)
  // Validate order ID format

  // Validate orderStatus
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

  // Find and update the order
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

  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  res.json(new ApiResponse(200, order, "Order status updated successfully"));
});
