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
import userMiddleware from "../middleware/auth.js";

const router = Router();

/* ================= CART CRUD OPERATIONS ================= */
router.get("/", userMiddleware, getCart);
router.post("/items", userMiddleware, addToCart);
router.put("/items", userMiddleware, updateCartItem);
router.delete("/items", userMiddleware, removeFromCart);
router.delete("/", userMiddleware, clearCart);

/* ================= CART COUPON OPERATIONS ================= */
router.post("/coupon", userMiddleware, applyCoupon);
router.delete("/coupon", userMiddleware, removeCoupon);

/* ================= ADVANCED CART FEATURES ================= */
router.get("/recommendations", userMiddleware, getCartRecommendations);
router.get("/analytics", userMiddleware, getCartAnalytics);
router.post("/merge-guest", userMiddleware, mergeGuestCart);

export default router;