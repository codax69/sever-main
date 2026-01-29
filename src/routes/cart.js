import { Router } from "express";
import {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  applyCoupon,
  removeCoupon,
  getCartRecommendations,
  getCartAnalytics,
  mergeGuestCart,
} from "../controller/cart.js";

import { verifyJWT } from "../middleware/auth.js";

const router = Router();

router.get(
  "/",
  verifyJWT,
  getCart
);

router.post(
  "/items",
  verifyJWT,
  addToCart
);

// Update cart item
router.put(
  "/items",
  verifyJWT,
  updateCartItem
);

// Remove item from cart
router.delete(
  "/items",
  verifyJWT,
  removeFromCart
);

// Clear cart
router.delete(
  "/",
  verifyJWT,
  clearCart
);

/* ================= CART COUPON OPERATIONS ================= */

// Apply coupon
router.post(
  "/coupon",
  verifyJWT,
  applyCoupon
);

// Remove coupon
router.delete(
  "/coupon",
  verifyJWT,
  removeCoupon
);

/* ================= ADVANCED CART FEATURES ================= */

// Product recommendations
router.get(
  "/recommendations",
  verifyJWT,
  getCartRecommendations
);

// Cart analytics (user-level, not admin)
router.get(
  "/analytics",
  verifyJWT,
  getCartAnalytics
);

// Merge guest cart into user cart after login
router.post(
  "/merge-guest",
  verifyJWT,
  mergeGuestCart
);

export default router;