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
} from "../controller/order.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Public routes - accessible by all users
router.get("/", getOrders);
router.post("/validate-coupon-basket", validateCouponForBasket);
router.get("/date-range", getOrdersByDateTimeRange);

// Protected routes - only admin can access

router.get("/today/orders", calculateTodayOrderTotal);
//razorpay
router.post("/create-order", addOrder);
router.post("/verify-payment", verifyPayment);
router.get("/get-key", getRazorpayKey);
router.post("/calculate-price", calculatePrice);

//status update
router.patch("/:_id/status", updateOrderStatus);
router.delete("/:id", adminMiddleware, deleteOrder);
router.patch("/:id", adminMiddleware, updateOrder);
router.get("/:orderId", getOrderById);
export default router;
