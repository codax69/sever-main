// routes/walletRoutes.js
import { Router } from "express";
import {
  getWallet,
  createWallet,
  getTransactionHistory,
  creditWallet,
  debitWallet,
  updateWalletStatus,
  reverseTransaction,
  checkBalance,
  getWalletStats,
} from "../controller/wallet.controller.js";
import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

// ============= AUTHENTICATED USER ROUTES =============
// Any logged-in user can access their own wallet
router.get("/", verifyJWT, getWallet);

router.post("/", verifyJWT, createWallet);

router.get("/transactions", verifyJWT, getTransactionHistory);

router.get("/balance", verifyJWT, checkBalance);

// ============= ADMIN ONLY ROUTES =============
// Only admin can credit/debit wallets and manage wallet operations
router.post("/credit", verifyJWT, isAdmin, creditWallet);

router.post("/debit", verifyJWT, isAdmin, debitWallet);

router.patch("/:walletId/status", verifyJWT, isAdmin, updateWalletStatus);

router.post(
  "/transactions/:transactionId/reverse",
  verifyJWT,
  isAdmin,
  reverseTransaction,
);

router.get("/stats", verifyJWT, isAdmin, getWalletStats);

export default router;
