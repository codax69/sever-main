// routes/walletRoutes.js
import { Router } from 'express';
import {
  getWallet,
  createWallet,
  getTransactionHistory,
  creditWallet,
  debitWallet,
  updateWalletStatus,
  reverseTransaction,
  checkBalance,
  getWalletStats
} from '../controller/wallet.controller.js';
import { verifyJWT, isAdmin } from '../middleware/auth.js';
import { ApiError } from '../utility/ApiError.js';

// Custom role-based authorization middleware
const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, 'Authentication required');
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(
        403,
        `Access denied. Required roles: ${allowedRoles.join(', ')}`
      );
    }

    next();
  };
};

// Validation middleware
const validate = (req, res, next) => {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    throw new ApiError(400, 'Validation failed', errors.array());
  }
  
  next();
};

const router = Router();

// ============= AUTHENTICATED USER ROUTES =============
// Any logged-in user can access their own wallet
router.get('/', verifyJWT, getWallet);

router.post('/', verifyJWT, createWallet);

router.get(
  '/transactions',
  verifyJWT,
  validate,
  getTransactionHistory
);

router.get('/balance', verifyJWT, checkBalance);

// ============= ADMIN ONLY ROUTES =============
// Only admin can credit/debit wallets and manage wallet operations
router.post(
  '/credit',
  verifyJWT,
  authorizeRoles('admin'),
  validate,
  creditWallet
);

router.post(
  '/debit',
  verifyJWT,
  authorizeRoles('admin'),
  validate,
  debitWallet
);

router.patch(
  '/:walletId/status',
  verifyJWT,
  authorizeRoles('admin'),
  validate,
  updateWalletStatus
);

router.post(
  '/transactions/:transactionId/reverse',
  verifyJWT,
  authorizeRoles('admin'),
  validate,
  reverseTransaction
);

router.get(
  '/stats',
  verifyJWT,
  authorizeRoles('admin'),
  getWalletStats
);

export default router;