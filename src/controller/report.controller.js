import Order from "../Model/order.js";
import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { ApiError } from "../utility/ApiError.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ================= CONFIG ================= */
const MIN_REDUCTION = 9;
const MAX_REDUCTION = 12;
const AVG_REDUCTION = 10;

const randomReduction = () =>
  Number((Math.random() * (MAX_REDUCTION - MIN_REDUCTION) + MIN_REDUCTION).toFixed(2));

/* ==========================================
   CALCULATE TOTAL REVENUE (EXCLUDING CANCELLED)
========================================== */
export const calculateTotalRevenue = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  // Default to all-time if no dates provided
  const query = {
    orderStatus: { 
      $nin: ["cancelled", "canceled", "Cancelled", "Canceled"] 
    }
  };

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    query.orderDate = { $gte: start, $lte: end };
  }

  // Get all non-cancelled orders
  const orders = await Order.find(query);

  // Calculate revenue metrics
  const totalOrders = orders.length;
  
  const totalRevenue = orders.reduce((sum, order) => {
    // Only add if order is NOT cancelled
    if (
      order.orderStatus !== "cancelled" && 
      order.orderStatus !== "canceled" &&
      order.orderStatus !== "Cancelled" &&
      order.orderStatus !== "Canceled"
    ) {
      return sum + (order.totalAmount || 0);
    }
    return sum;
  }, 0);

  const totalCouponDiscount = orders.reduce((sum, order) => {
    if (
      order.orderStatus !== "cancelled" && 
      order.orderStatus !== "canceled" &&
      order.orderStatus !== "Cancelled" &&
      order.orderStatus !== "Canceled"
    ) {
      return sum + (order.couponDiscount || 0);
    }
    return sum;
  }, 0);

  const totalDeliveryCharges = orders.reduce((sum, order) => {
    if (
      order.orderStatus !== "cancelled" && 
      order.orderStatus !== "canceled" &&
      order.orderStatus !== "Cancelled" &&
      order.orderStatus !== "Canceled"
    ) {
      return sum + (order.deliveryCharges || 0);
    }
    return sum;
  }, 0);

  const netRevenue = totalRevenue - totalCouponDiscount;
  const estimatedPurchaseCost = totalRevenue * (1 - AVG_REDUCTION / 100);
  const estimatedProfit = totalRevenue - estimatedPurchaseCost;

  return res.status(200).json(
    new ApiResponse(200, {
      dateRange: startDate && endDate ? { start: startDate, end: endDate } : "All Time",
      totalOrders,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalCouponDiscount: parseFloat(totalCouponDiscount.toFixed(2)),
      totalDeliveryCharges: parseFloat(totalDeliveryCharges.toFixed(2)),
      netRevenue: parseFloat(netRevenue.toFixed(2)),
      estimatedPurchaseCost: parseFloat(estimatedPurchaseCost.toFixed(2)),
      estimatedProfit: parseFloat(estimatedProfit.toFixed(2)),
      avgOrderValue: totalOrders ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0,
      avgReduction: `${AVG_REDUCTION}%`,
      note: "Cancelled orders are excluded from all calculations"
    }, "Revenue calculated successfully (cancelled orders excluded)")
  );
});

/* ==========================================
   DAILY EXCEL REPORT (EXCLUDING CANCELLED)
========================================== */
export const generateDailyOrderReport = asyncHandler(async (req, res) => {
  let { startDate, endDate } = req.query;

  // Default date range if not provided
  if (!startDate) startDate = "2025-12-07";
  if (!endDate) endDate = "2026-01-12";

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // ✅ EXCLUDE CANCELLED ORDERS - Multiple variations
  const orders = await Order.find({
    orderDate: { $gte: start, $lte: end },
    orderStatus: { 
      $nin: ["cancelled", "canceled", "Cancelled", "Canceled"]
    },
  }).sort({ orderDate: 1 });

  if (!orders.length) {
    throw new ApiError(404, "No non-cancelled orders found for selected range");
  }

  /* ---------- DAILY AGGREGATION ---------- */
  const dailyMap = new Map();
  const cursor = new Date(start);

  while (cursor <= end) {
    const key = cursor.toISOString().split("T")[0];
    dailyMap.set(key, {
      orders: 0,
      revenue: 0,
      couponDiscount: 0,
      deliveryCharges: 0,
      reduction: randomReduction(),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  // ✅ ONLY NON-CANCELLED ORDERS
  orders.forEach((order) => {
    // Triple-check order is not cancelled
    const status = order.orderStatus?.toLowerCase();
    if (status === "cancelled" || status === "canceled") {
      return; // Skip cancelled orders
    }

    const key = order.orderDate.toISOString().split("T")[0];
    if (dailyMap.has(key)) {
      const day = dailyMap.get(key);
      day.orders += 1;
      day.revenue += order.totalAmount || 0;
      day.couponDiscount += order.couponDiscount || 0;
      day.deliveryCharges += order.deliveryCharges || 0;
    }
  });

  /* ---------- EXCEL WORKBOOK ---------- */
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Daily Revenue (Non-Cancelled)");

  ws.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Day", key: "day", width: 12 },
    { header: "Orders", key: "orders", width: 12 },
    { header: "Revenue (₹)", key: "revenue", width: 16 },
    { header: "Coupon Discount (₹)", key: "couponDiscount", width: 18 },
    { header: "Delivery Charges (₹)", key: "deliveryCharges", width: 18 },
    { header: "Net Revenue (₹)", key: "netRevenue", width: 16 },
    { header: "Reduction %", key: "reduction", width: 14 },
    { header: "Purchase Cost (₹)", key: "cost", width: 18 },
    { header: "Profit (₹)", key: "profit", width: 14 },
  ];

  // Header styling
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4472C4" },
  };
  ws.getRow(1).height = 25;

  let totalOrders = 0;
  let totalRevenue = 0;
  let totalCouponDiscount = 0;
  let totalDeliveryCharges = 0;
  let totalCost = 0;

  // Add daily rows
  [...dailyMap.keys()].sort().forEach((date) => {
    const day = dailyMap.get(date);
    const revenue = day.revenue;
    const couponDiscount = day.couponDiscount;
    const deliveryCharges = day.deliveryCharges;
    const netRevenue = revenue - couponDiscount;
    const reduction = revenue > 0 ? day.reduction : 0;
    const cost = revenue * (1 - reduction / 100);
    const profit = revenue - cost;

    totalOrders += day.orders;
    totalRevenue += revenue;
    totalCouponDiscount += couponDiscount;
    totalDeliveryCharges += deliveryCharges;
    totalCost += cost;

    const row = ws.addRow({
      date,
      day: new Date(date).toLocaleDateString("en-US", { weekday: "short" }),
      orders: day.orders,
      revenue: revenue.toFixed(2),
      couponDiscount: couponDiscount.toFixed(2),
      deliveryCharges: deliveryCharges.toFixed(2),
      netRevenue: netRevenue.toFixed(2),
      reduction: reduction ? `${reduction}%` : "",
      cost: cost.toFixed(2),
      profit: profit.toFixed(2),
    });

    // Alternate row colors
    if (ws.rowCount % 2 === 0) {
      row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F3F3" },
      };
    }
  });

  // Total row
  ws.addRow({});
  const totalRow = ws.addRow({
    date: "TOTAL",
    orders: totalOrders,
    revenue: totalRevenue.toFixed(2),
    couponDiscount: totalCouponDiscount.toFixed(2),
    deliveryCharges: totalDeliveryCharges.toFixed(2),
    netRevenue: (totalRevenue - totalCouponDiscount).toFixed(2),
    cost: totalCost.toFixed(2),
    profit: (totalRevenue - totalCost).toFixed(2),
  });

  totalRow.font = { bold: true, size: 12 };
  totalRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFEB3B" },
  };

  // Apply borders
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  });

  // Add note about cancelled orders
  ws.addRow({});
  ws.addRow({});
  const noteRow = ws.addRow({
    date: "NOTE: Cancelled orders are excluded from all calculations above",
  });
  noteRow.font = { italic: true, color: { argb: "FFFF0000" } };
  ws.mergeCells(`A${ws.rowCount}:J${ws.rowCount}`);

  /* ---------- FILE GENERATION ---------- */
  const tempDir = path.join(__dirname, "../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const filename = `daily_revenue_${startDate}_to_${endDate}_${Date.now()}.xlsx`;
  const filepath = path.join(tempDir, filename);

  await wb.xlsx.writeFile(filepath);

  res.download(filepath, filename, (err) => {
    if (err) console.error("Download error:", err);
    fs.unlink(filepath, (unlinkErr) => {
      if (unlinkErr) console.error("File cleanup error:", unlinkErr);
    });
  });
});

/* ==========================================
   REPORT STATS (EXCLUDING CANCELLED)
========================================== */
export const getReportStats = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date required");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // ✅ EXCLUDE ALL CANCELLED ORDERS
  const orders = await Order.find({
    orderDate: { $gte: start, $lte: end },
    orderStatus: {
      $nin: ["cancelled", "canceled", "Cancelled", "Canceled"]
    },
  });

  const totalOrders = orders.length;

  // ✅ Calculate only from non-cancelled orders
  const totalRevenue = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
  const totalCouponDiscount = orders.reduce((sum, order) => sum + (order.couponDiscount || 0), 0);
  const totalDeliveryCharges = orders.reduce((sum, order) => sum + (order.deliveryCharges || 0), 0);

  const netRevenue = totalRevenue - totalCouponDiscount;
  const estimatedPurchaseCost = totalRevenue * (1 - AVG_REDUCTION / 100);
  const estimatedProfit = totalRevenue - estimatedPurchaseCost;

  return res.status(200).json(
    new ApiResponse(200, {
      dateRange: { start: startDate, end: endDate },
      totalOrders,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalCouponDiscount: parseFloat(totalCouponDiscount.toFixed(2)),
      totalDeliveryCharges: parseFloat(totalDeliveryCharges.toFixed(2)),
      netRevenue: parseFloat(netRevenue.toFixed(2)),
      estimatedPurchaseCost: parseFloat(estimatedPurchaseCost.toFixed(2)),
      estimatedProfit: parseFloat(estimatedProfit.toFixed(2)),
      avgOrderValue: totalOrders ? parseFloat((totalRevenue / totalOrders).toFixed(2)) : 0,
      avgReduction: `${AVG_REDUCTION}%`,
      note: "Cancelled orders excluded"
    }, "Report statistics fetched (cancelled orders excluded)")
  );
});

/* ==========================================
   CANCELLED ORDERS REPORT
========================================== */
export const getCancelledOrdersReport = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date required");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // ✅ GET ONLY CANCELLED ORDERS
  const cancelledOrders = await Order.find({
    orderDate: { $gte: start, $lte: end },
    orderStatus: {
      $in: ["cancelled", "canceled", "Cancelled", "Canceled"]
    },
  }).sort({ orderDate: -1 });

  const totalCancelledOrders = cancelledOrders.length;
  const potentialLostRevenue = cancelledOrders.reduce((sum, order) => {
    return sum + (order.totalAmount || 0);
  }, 0);

  return res.status(200).json(
    new ApiResponse(200, {
      dateRange: { start: startDate, end: endDate },
      totalCancelledOrders,
      potentialLostRevenue: parseFloat(potentialLostRevenue.toFixed(2)),
      orders: cancelledOrders,
    }, "Cancelled orders report fetched successfully")
  );
});

/* ==========================================
   REVENUE COMPARISON (CANCELLED vs NON-CANCELLED)
========================================== */
export const getRevenueComparison = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Start and end date required");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // Get all orders (including cancelled)
  const allOrders = await Order.find({
    orderDate: { $gte: start, $lte: end },
  });

  // Get only non-cancelled orders
  const activeOrders = await Order.find({
    orderDate: { $gte: start, $lte: end },
    orderStatus: {
      $nin: ["cancelled", "canceled", "Cancelled", "Canceled"]
    },
  });

  // Get only cancelled orders
  const cancelledOrders = await Order.find({
    orderDate: { $gte: start, $lte: end },
    orderStatus: {
      $in: ["cancelled", "canceled", "Cancelled", "Canceled"]
    },
  });

  const totalOrders = allOrders.length;
  const activeOrdersCount = activeOrders.length;
  const cancelledOrdersCount = cancelledOrders.length;

  const actualRevenue = activeOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
  const lostRevenue = cancelledOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
  const potentialRevenue = actualRevenue + lostRevenue;

  const cancellationRate = totalOrders > 0 ? (cancelledOrdersCount / totalOrders) * 100 : 0;

  return res.status(200).json(
    new ApiResponse(200, {
      dateRange: { start: startDate, end: endDate },
      summary: {
        totalOrders,
        activeOrders: activeOrdersCount,
        cancelledOrders: cancelledOrdersCount,
        cancellationRate: parseFloat(cancellationRate.toFixed(2)),
      },
      revenue: {
        actualRevenue: parseFloat(actualRevenue.toFixed(2)),
        lostRevenue: parseFloat(lostRevenue.toFixed(2)),
        potentialRevenue: parseFloat(potentialRevenue.toFixed(2)),
        revenueImpact: parseFloat(((lostRevenue / potentialRevenue) * 100).toFixed(2)),
      },
    }, "Revenue comparison fetched successfully")
  );
});