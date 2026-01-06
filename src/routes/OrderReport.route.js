import express from "express";
import {
  getDashboardOverview,
  getRevenueReport,
  getTopCustomers,
  getRepeatCustomersAnalysis,
  getMostSoldVegetables,
  getOrderStatusReport,
  getPaymentMethodReport,
  getCouponUsageReport,
  getTimeSlotAnalysis,
  getOrderTypeReport,
  getMonthlyTrends
} from "../controller/OrderReport.controller.js";

const router = express.Router();

// ===== DASHBOARD =====
// GET /api/reports/dashboard
router.get("/dashboard", getDashboardOverview);

// ===== REVENUE REPORTS =====
// GET /api/reports/revenue?startDate=2024-01-01&endDate=2024-12-31&groupBy=day
router.get("/revenue", getRevenueReport);

// ===== CUSTOMER REPORTS =====
// GET /api/reports/top-customers?limit=10&sortBy=revenue
router.get("/top-customers", getTopCustomers);

// GET /api/reports/repeat-customers
router.get("/repeat-customers", getRepeatCustomersAnalysis);

// ===== PRODUCT REPORTS =====
// GET /api/reports/most-sold-vegetables?limit=10&sortBy=quantity
router.get("/most-sold-vegetables", getMostSoldVegetables);

// ===== ORDER REPORTS =====
// GET /api/reports/order-status?startDate=2024-01-01&endDate=2024-12-31
router.get("/order-status", getOrderStatusReport);

// GET /api/reports/order-type
router.get("/order-type", getOrderTypeReport);

// ===== PAYMENT REPORTS =====
// GET /api/reports/payment-methods
router.get("/payment-methods", getPaymentMethodReport);

// ===== COUPON REPORTS =====
// GET /api/reports/coupon-usage
router.get("/coupon-usage", getCouponUsageReport);

// ===== OPERATIONAL REPORTS =====
// GET /api/reports/time-slots
router.get("/time-slots", getTimeSlotAnalysis);

// ===== TRENDS =====
// GET /api/reports/monthly-trends?months=6
router.get("/monthly-trends", getMonthlyTrends);

export default router;