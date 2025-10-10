import Order from "../Model/order.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import Razorpay from "razorpay";
import "dotenv/config";
import crypto from "crypto";
import {DELIVERY_CHARGES} from "../../const.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// Get all orders
export const getOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find();
  res.json(new ApiResponse(200, orders, "Orders fetched successfully"));
});

// Get order by MongoDB _id
export const getOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findById(id);
  
  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }
  
  res.json(new ApiResponse(200, order, "Order fetched successfully"));
});

// Add order (COD or ONLINE)
export const addOrder = asyncHandler(async (req, res) => {
  const {
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderId,
    paymentMethod,
  } = req.body;

  if (!customerInfo?.name || !customerInfo?.mobile)
    return res.status(400).json(new ApiResponse(400, null, "Customer info required"));

  if (!selectedOffer?.title || !selectedOffer?.price)
    return res.status(400).json(new ApiResponse(400, null, "Valid offer required"));

  if (!Array.isArray(selectedVegetables) || selectedVegetables.length === 0)
    return res.status(400).json(new ApiResponse(400, null, "At least one vegetable required"));

  if (!orderId)
    return res.status(400).json(new ApiResponse(400, null, "Order ID is required"));

  try {
    if (paymentMethod === "COD") {
      const order = new Order({
        customerInfo,
        selectedOffer,
        selectedVegetables,
        orderDate: new Date(),
        totalAmount: selectedOffer.price,
        orderId,
        paymentMethod,
        paymentStatus: "pending",
      });
      await order.save();
      return res.json(
        new ApiResponse(201, order, "Order placed successfully with COD")
      );
    }
    
    const razorpayOrder = await razorpay.orders.create({
      amount: selectedOffer.price * 100 + DELIVERY_CHARGES,
      currency: "INR",
      receipt: orderId,
      payment_capture: 1,
    });

    // Return Razorpay order details to frontend
    res.json(
      new ApiResponse(
        201,
        {
          razorpayOrder,
          orderData: {
            customerInfo,
            selectedOffer,
            selectedVegetables,
            orderId,
          },
        },
        "Razorpay order created. Complete payment to save order."
      )
    );
  } catch (error) {
    console.error("Error in addOrder:", error);
    res.status(500).json(new ApiResponse(500, null, "Error creating order"));
  }
});

// Verify payment and save order
export const verifyPayment = asyncHandler(async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderId,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing payment data"));

  // Validate order data
  if (!customerInfo?.name || !customerInfo?.mobile)
    return res.status(400).json(new ApiResponse(400, null, "Customer info required"));

  if (!selectedOffer?.title || !selectedOffer?.price)
    return res.status(400).json(new ApiResponse(400, null, "Valid offer required"));

  if (!Array.isArray(selectedVegetables) || selectedVegetables.length === 0)
    return res.status(400).json(new ApiResponse(400, null, "At least one vegetable required"));

  if (!orderId)
    return res.status(400).json(new ApiResponse(400, null, "Order ID is required"));

  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Payment verification failed"));
  }

  // Payment successful → save order in DB
  const order = new Order({
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderDate: new Date(),
    totalAmount: selectedOffer.price + DELIVERY_CHARGES,
    orderId,
    paymentMethod: "ONLINE",
    paymentStatus: "completed",
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
  });

  await order.save();
  res.json(
    new ApiResponse(200, order, "Payment verified and order saved successfully")
  );
});

// Delete order
export const deleteOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await Order.findByIdAndDelete(id);
  if (!result)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  res.json(new ApiResponse(200, result, "Order deleted successfully"));
});

// Update order
export const updateOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  const order = await Order.findByIdAndUpdate(id, updateData, { new: true });
  if (!order)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  res.json(new ApiResponse(200, order, "Order updated successfully"));
});

// Get Razorpay key
export const getRazorpayKey = asyncHandler(async (req, res) => {
  res.json(
    new ApiResponse(
      200,
      { key: process.env.RAZORPAY_KEY_ID },
      "Razorpay key fetched successfully"
    )
  );
});