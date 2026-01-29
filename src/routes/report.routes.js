import express from "express";
import {
  calculateTotalRevenue,
  generateDailyOrderReport,
  getReportStats,
  getCancelledOrdersReport,
  getRevenueComparison,
} from "../controller/report.controller.js";

const router = express.Router();

/* ==========================================
   REVENUE REPORTS - ADMIN ONLY
   All routes exclude cancelled orders from revenue calculations
========================================== */

// ✅ Calculate Total Revenue (Excluding Cancelled Orders)
// GET /api/reports/revenue
// Query params: ?startDate=2025-12-07&endDate=2026-01-12 (optional)
// Returns: Total revenue, orders, profit, discounts (cancelled orders excluded)
router.get(
  "/revenue",
  calculateTotalRevenue
);

// ✅ Generate Daily Excel Report (Excluding Cancelled Orders)
// GET /api/reports/daily-excel
// Query params: ?startDate=2025-12-07&endDate=2026-01-12
// Downloads: Excel file with daily breakdown (cancelled orders excluded)
router.get(
  "/daily-excel",
  generateDailyOrderReport
);

// ✅ Get Report Statistics (Excluding Cancelled Orders)
// GET /api/reports/stats
// Query params: ?startDate=2025-12-07&endDate=2026-01-12 (required)
// Returns: Quick stats for dashboard (cancelled orders excluded)
router.get(
  "/stats",
  getReportStats
);

// ✅ Get Cancelled Orders Report
// GET /api/reports/cancelled
// Query params: ?startDate=2025-12-07&endDate=2026-01-12 (required)
// Returns: All cancelled orders and lost revenue
router.get(
  "/cancelled",
  getCancelledOrdersReport
);

// ✅ Get Revenue Comparison (Active vs Cancelled)
// GET /api/reports/comparison
// Query params: ?startDate=2025-12-07&endDate=2026-01-12 (required)
// Returns: Actual revenue vs potential revenue, cancellation impact
router.get(
  "/comparison",
  getRevenueComparison
);

export default router;