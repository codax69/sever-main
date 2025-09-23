import Order from "../Model/order.js";
import { ApiResponse } from "../utility/ApiRespoense.js";
import { asyncHandler } from "../utility/AsyncHandler.js";


export const getOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find();
  res.json(new ApiResponse(200, orders, "Orders fetched successfully"));
});


export const getOrderById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findById(id);
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
    orderDate,
    totalAmount,
    orderId,
  } = req.body;
  const order = new Order({
    customerInfo,
    selectedOffer,
    selectedVegetables,
    orderDate,
    totalAmount,
    orderId,
  });
  await order.save();
  res.json(new ApiResponse(201, order, "Order added successfully"));
});


export const deleteOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await Order.findByIdAndDelete(id);
  if (!result) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }
  res.json(new ApiResponse(200, result, "Order deleted successfully"));
});


export const updateOrder = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  const order = await Order.findByIdAndUpdate(id, updateData, { new: true });
  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }
  res.json(new ApiResponse(200, order, "Order updated successfully"));
});
