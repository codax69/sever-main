import { Router } from "express";
import {
  getOrders,
  getOrderById,
  addOrder,
  deleteOrder,
  updateOrder,
  verifyPayment,
  getRazorpayKey,
  calculateTodayOrderTotal,
  calculatePrice,
  updateOrderStatus,
  validateCouponForBasket,
  getOrdersByDateTimeRange,
  getOrdersByStatus,
  getOrdersByMultipleStatuses,
  getOrderStatusStats,
} from "../controller/order.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Public routes - accessible by all users
router.get("/", getOrders);
router.post("/validate-coupon-basket", validateCouponForBasket);

// Order filtering routes
router.get("/date-range", getOrdersByDateTimeRange);
router.get("/status", getOrdersByStatus); // ?status=pending
router.get("/statuses", getOrdersByMultipleStatuses); // ?statuses=pending,confirmed
router.get("/status-stats", getOrderStatusStats); // Statistics by status

// Protected routes - only admin can access
router.get("/today/orders", calculateTodayOrderTotal);

// Razorpay
router.post("/create-order", addOrder);
router.post("/verify-payment", verifyPayment);
router.get("/get-key", getRazorpayKey);
router.post("/calculate-price", calculatePrice);

// Status update
router.patch("/:_id/status", updateOrderStatus);
router.delete("/:id", adminMiddleware, deleteOrder);
router.patch("/:id", adminMiddleware, updateOrder);
router.get("/:orderId", getOrderById);

export default router;