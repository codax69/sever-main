import { Router } from "express";
import {
  getOrders,
  getOrderById,
  addOrder,
  deleteOrder,
  updateOrder
} from "../controller/order.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Public routes - accessible by all users
router.get("/", getOrders);
router.get("/:id", getOrderById);
router.post("/add", addOrder);

// Protected routes - only admin can access
router.delete("/:id", adminMiddleware, deleteOrder);
router.put("/:id", adminMiddleware, updateOrder);

export default router;