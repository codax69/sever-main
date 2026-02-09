import { Router } from "express";
import {
  getCashbackSummary,
  getCashbackHistory,
  getOrderCashback,
  getRecentCashback,
} from "../controller/cashback.controller.js";
import { verifyJWT } from "../middleware/auth.js";

const router = Router();

// ============= AUTHENTICATED USER ROUTES =============
// Get user's total cashback summary
router.get("/summary", verifyJWT, getCashbackSummary);

// Get user's cashback transaction history
router.get("/history", verifyJWT, getCashbackHistory);

// Get recent cashback (last 5)
router.get("/recent", verifyJWT, getRecentCashback);

// Get cashback details for a specific order
router.get("/order/:orderId", verifyJWT, getOrderCashback);

export default router;
