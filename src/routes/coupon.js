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

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

/* =======================
   PUBLIC ROUTES
======================= */

router.post("/validate", validateCoupon);
router.post("/apply", applyCoupon);
router.get("/", getCoupons);
router.get("/:id", getCouponById);

/* =======================
   ADMIN ROUTES
======================= */

router.post("/", verifyJWT, isAdmin, createCoupon);
router.patch("/:id", verifyJWT, isAdmin, updateCoupon);
router.delete("/:id", verifyJWT, isAdmin, deleteCoupon);

export default router;
