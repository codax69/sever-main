import express from "express";
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
  mergeGuestCart, // ← was missing
} from "../controller/cart.js";
import { verifyJWT } from "../middleware/auth.js"; 
const router = express.Router();

// All cart routes require authentication
router.use(verifyJWT);

// ── Core cart ─────────────────────────────────────────────
router.get("/", getCart);
router.post("/add", addToCart);
router.put("/update", updateCartItem);
router.delete("/remove", removeFromCart);
router.delete("/clear", clearCart);

// ── Coupon ────────────────────────────────────────────────
router.post("/coupon/apply", applyCoupon);
router.delete("/coupon", removeCoupon);

// ── Extras ────────────────────────────────────────────────
router.get("/recommendations", getCartRecommendations);
router.get("/analytics", getCartAnalytics);
router.post("/merge", mergeGuestCart); // ← was 404

export default router;