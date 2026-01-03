// Enhanced Invoice Routes with comprehensive endpoints
import express from "express";
import {
  invoiceController,
  getInvoicePDF,
  bulkProcessInvoices,
  getInvoiceAnalytics,
  retryFailedEmails
} from "../controller/invoice.js";
import userMiddleware from "../middleware/auth.js";
import adminMiddleware from "../middleware/admin.js";

const router = express.Router();

// Public routes (with appropriate auth)
// Generate and send invoice for a given orderId
router.post("/send/:orderId", userMiddleware, invoiceController);

// Get invoice PDF without sending email
router.get("/pdf/:orderId", userMiddleware, getInvoicePDF);

// Admin-only routes
// Bulk process multiple invoices
router.post("/bulk-process", userMiddleware, adminMiddleware, bulkProcessInvoices);

// Get invoice analytics and statistics
router.get("/analytics", userMiddleware, adminMiddleware, getInvoiceAnalytics);

// Retry failed email deliveries
router.post("/retry-emails", userMiddleware, adminMiddleware, retryFailedEmails);

// Query parameters for enhanced functionality
// Example: POST /api/invoice/send/ORDER123?sendEmail=true&emailType=invoice&priority=high
// Example: GET /api/invoice/pdf/ORDER123
// Example: POST /api/invoice/bulk-process (body: { orderIds: [...], options: {...} })

export default router;
