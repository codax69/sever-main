import express from "express";
import {
  invoiceController,
  getInvoicePDF,
  bulkProcessInvoices,
  getInvoiceAnalytics,
  retryFailedEmails,
} from "../controller/invoice.js";

import {
  verifyJWT,
  isAdmin,
} from "../middleware/auth.js";

// Custom role-based authorization middleware
const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, "Authentication required");
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(
        403, 
        `Access denied. Required roles: ${allowedRoles.join(", ")}`
      );
    }

    next();
  };
};

const router = express.Router();

// ============= ADMIN & EDITOR ROUTES =============
router.post(
  "/bulk-process",
  verifyJWT,
  authorizeRoles("admin", "editor"),
  bulkProcessInvoices
);

// ============= ADMIN ONLY ROUTES =============
router.get(
  "/analytics",
  verifyJWT,
  isAdmin,
  getInvoiceAnalytics
);

router.post(
  "/retry-emails",
  verifyJWT,
  isAdmin,
  retryFailedEmails
);

// ============= AUTHENTICATED USER ROUTES =============
// Any logged-in user can send invoice or get PDF for their orders
router.post(
  "/send/:orderId",
  verifyJWT,
  invoiceController
);

router.get(
  "/pdf/:orderId",
  verifyJWT,
  getInvoicePDF
);

export default router;