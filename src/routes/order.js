import { Router } from "express";
import {
  getOrders,
  getOrderById,
  addOrder,
  deleteOrder,
  updateOrder,
  verifyPayment,
  getRazorpayKey
} from "../controller/order.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Public routes - accessible by all users
router.get("/", getOrders);
router.get("/:id", getOrderById);

// Protected routes - only admin can access
router.delete("/:id", adminMiddleware, deleteOrder);
router.patch("/:id", adminMiddleware, updateOrder);

//razorpay
router.post('/create-order', addOrder);
router.post('/verify-payment', verifyPayment);
router.get('/get-key', getRazorpayKey);

export default router;