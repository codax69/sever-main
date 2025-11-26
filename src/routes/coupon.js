import { Router } from "express";
import {
  validateCoupon,
  applyCoupon,
  createCoupon,
  getCoupons,
  getCouponById,
  updateCoupon,
  deleteCoupon,
} from "../controller/coupon.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Public routes
router.post("/validate", validateCoupon);
router.post("/apply", applyCoupon);
router.get("/", getCoupons);
router.get("/:id", getCouponById);

// Admin protected routes
router.post("/", adminMiddleware, createCoupon);
router.patch("/:id", adminMiddleware, updateCoupon);
router.delete("/:id", adminMiddleware, deleteCoupon);

export default router;