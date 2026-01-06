import Order from "../Model/order.js";
import mongoose from "mongoose";

// ===== DASHBOARD OVERVIEW =====
export const getDashboardOverview = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const [
      totalOrders,
      totalRevenue,
      deliveredOrders,
      pendingOrders,
      cancelledOrders
    ] = await Promise.all([
      Order.countDocuments(dateFilter),
      Order.aggregate([
        { $match: { ...dateFilter, paymentStatus: "completed" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
      ]),
      Order.countDocuments({ ...dateFilter, orderStatus: "delivered" }),
      Order.countDocuments({ ...dateFilter, orderStatus: { $in: ["placed", "processed", "shipped"] } }),
      Order.countDocuments({ ...dateFilter, orderStatus: "cancelled" })
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalOrders,
        totalRevenue: totalRevenue[0]?.total || 0,
        deliveredOrders,
        pendingOrders,
        cancelledOrders,
        averageOrderValue: totalOrders > 0 ? (totalRevenue[0]?.total || 0) / totalOrders : 0
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard overview",
      error: error.message
    });
  }
};

// ===== REVENUE REPORTS =====
export const getRevenueReport = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = "day" } = req.query;
    
    const matchStage = {
      paymentStatus: "completed"
    };
    
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    let groupFormat;
    switch (groupBy) {
      case "month":
        groupFormat = { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } };
        break;
      case "week":
        groupFormat = { year: { $year: "$createdAt" }, week: { $week: "$createdAt" } };
        break;
      default: // day
        groupFormat = { 
          year: { $year: "$createdAt" }, 
          month: { $month: "$createdAt" },
          day: { $dayOfMonth: "$createdAt" }
        };
    }

    const revenueData = await Order.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: groupFormat,
          totalRevenue: { $sum: "$totalAmount" },
          orderCount: { $sum: 1 },
          averageOrderValue: { $avg: "$totalAmount" },
          totalDiscount: { $sum: "$couponDiscount" },
          deliveryChargesCollected: { $sum: "$deliveryCharges" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1, "_id.week": 1 } }
    ]);

    const totalStats = await Order.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
          totalOrders: { $sum: 1 },
          totalDiscount: { $sum: "$couponDiscount" },
          totalDeliveryCharges: { $sum: "$deliveryCharges" }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        revenueByPeriod: revenueData,
        summary: totalStats[0] || {
          totalRevenue: 0,
          totalOrders: 0,
          totalDiscount: 0,
          totalDeliveryCharges: 0
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching revenue report",
      error: error.message
    });
  }
};

// ===== TOP CUSTOMERS (REPEAT CUSTOMERS) =====
export const getTopCustomers = async (req, res) => {
  try {
    const { limit = 10, sortBy = "revenue" } = req.query;
    
    const sortField = sortBy === "orders" ? "totalOrders" : "totalRevenue";

    const topCustomers = await Order.aggregate([
      {
        $match: {
          paymentStatus: "completed"
        }
      },
      {
        $group: {
          _id: "$customerInfo",
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
          averageOrderValue: { $avg: "$totalAmount" },
          lastOrderDate: { $max: "$createdAt" }
        }
      },
      {
        $lookup: {
          from: "customers",
          localField: "_id",
          foreignField: "_id",
          as: "customerDetails"
        }
      },
      { $unwind: "$customerDetails" },
      {
        $project: {
          _id: 1,
          customerName: "$customerDetails.name",
          customerEmail: "$customerDetails.email",
          customerPhone: "$customerDetails.phone",
          totalOrders: 1,
          totalRevenue: 1,
          averageOrderValue: 1,
          lastOrderDate: 1
        }
      },
      { $sort: { [sortField]: -1 } },
      { $limit: parseInt(limit) }
    ]);

    res.status(200).json({
      success: true,
      data: topCustomers
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching top customers",
      error: error.message
    });
  }
};

// ===== REPEAT CUSTOMERS ANALYSIS =====
export const getRepeatCustomersAnalysis = async (req, res) => {
  try {
    const repeatCustomers = await Order.aggregate([
      {
        $group: {
          _id: "$customerInfo",
          orderCount: { $sum: 1 },
          totalSpent: { $sum: "$totalAmount" },
          firstOrder: { $min: "$createdAt" },
          lastOrder: { $max: "$createdAt" }
        }
      },
      {
        $facet: {
          repeatCustomers: [
            { $match: { orderCount: { $gte: 2 } } },
            {
              $lookup: {
                from: "customers",
                localField: "_id",
                foreignField: "_id",
                as: "customer"
              }
            },
            { $unwind: "$customer" },
            {
              $project: {
                customerId: "$_id",
                customerName: "$customer.name",
                customerEmail: "$customer.email",
                orderCount: 1,
                totalSpent: 1,
                firstOrder: 1,
                lastOrder: 1,
                averageOrderValue: { $divide: ["$totalSpent", "$orderCount"] }
              }
            },
            { $sort: { orderCount: -1 } }
          ],
          stats: [
            {
              $group: {
                _id: null,
                totalCustomers: { $sum: 1 },
                repeatCustomers: {
                  $sum: { $cond: [{ $gte: ["$orderCount", 2] }, 1, 0] }
                },
                oneTimeCustomers: {
                  $sum: { $cond: [{ $eq: ["$orderCount", 1] }, 1, 0] }
                }
              }
            }
          ]
        }
      }
    ]);

    const stats = repeatCustomers[0].stats[0] || {
      totalCustomers: 0,
      repeatCustomers: 0,
      oneTimeCustomers: 0
    };

    res.status(200).json({
      success: true,
      data: {
        repeatCustomers: repeatCustomers[0].repeatCustomers,
        statistics: {
          ...stats,
          repeatRate: stats.totalCustomers > 0 
            ? ((stats.repeatCustomers / stats.totalCustomers) * 100).toFixed(2) + "%"
            : "0%"
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching repeat customers analysis",
      error: error.message
    });
  }
};

// ===== MOST SOLD VEGETABLES =====
export const getMostSoldVegetables = async (req, res) => {
  try {
    const { limit = 10, sortBy = "quantity" } = req.query;
    
    const sortField = sortBy === "revenue" ? "totalRevenue" : "totalQuantity";

    const topVegetables = await Order.aggregate([
      { $unwind: "$selectedVegetables" },
      {
        $group: {
          _id: "$selectedVegetables.vegetable",
          totalQuantity: { $sum: "$selectedVegetables.quantity" },
          totalRevenue: { $sum: "$selectedVegetables.subtotal" },
          orderCount: { $sum: 1 },
          averagePrice: { $avg: "$selectedVegetables.pricePerUnit" }
        }
      },
      {
        $lookup: {
          from: "vegetables",
          localField: "_id",
          foreignField: "_id",
          as: "vegetableDetails"
        }
      },
      { $unwind: "$vegetableDetails" },
      {
        $project: {
          _id: 1,
          vegetableName: "$vegetableDetails.name",
          vegetableImage: "$vegetableDetails.image",
          category: "$vegetableDetails.category",
          totalQuantity: 1,
          totalRevenue: 1,
          orderCount: 1,
          averagePrice: 1
        }
      },
      { $sort: { [sortField]: -1 } },
      { $limit: parseInt(limit) }
    ]);

    res.status(200).json({
      success: true,
      data: topVegetables
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching most sold vegetables",
      error: error.message
    });
  }
};

// ===== ORDER STATUS REPORT =====
export const getOrderStatusReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const statusReport = await Order.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: "$orderStatus",
          count: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" }
        }
      },
      { $sort: { count: -1 } }
    ]);

    const placedAndDelivered = await Order.aggregate([
      { $match: dateFilter },
      {
        $facet: {
          placed: [
            { $match: { orderStatus: "placed" } },
            { $count: "count" }
          ],
          delivered: [
            { $match: { orderStatus: "delivered" } },
            { $count: "count" }
          ],
          deliveryRate: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                delivered: {
                  $sum: { $cond: [{ $eq: ["$orderStatus", "delivered"] }, 1, 0] }
                }
              }
            }
          ]
        }
      }
    ]);

    const stats = placedAndDelivered[0];
    const totalOrders = stats.deliveryRate[0]?.total || 0;
    const deliveredCount = stats.deliveryRate[0]?.delivered || 0;

    res.status(200).json({
      success: true,
      data: {
        statusBreakdown: statusReport,
        highlights: {
          placedOrders: stats.placed[0]?.count || 0,
          deliveredOrders: deliveredCount,
          deliveryRate: totalOrders > 0 
            ? ((deliveredCount / totalOrders) * 100).toFixed(2) + "%"
            : "0%"
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching order status report",
      error: error.message
    });
  }
};

// ===== PAYMENT METHOD REPORT =====
export const getPaymentMethodReport = async (req, res) => {
  try {
    const paymentReport = await Order.aggregate([
      {
        $group: {
          _id: "$paymentMethod",
          count: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
          completedPayments: {
            $sum: { $cond: [{ $eq: ["$paymentStatus", "completed"] }, 1, 0] }
          },
          pendingPayments: {
            $sum: { $cond: [{ $eq: ["$paymentStatus", "pending"] }, 1, 0] }
          },
          failedPayments: {
            $sum: { $cond: [{ $eq: ["$paymentStatus", "failed"] }, 1, 0] }
          }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: paymentReport
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching payment method report",
      error: error.message
    });
  }
};

// ===== COUPON USAGE REPORT =====
export const getCouponUsageReport = async (req, res) => {
  try {
    const couponReport = await Order.aggregate([
      {
        $match: {
          couponCode: { $ne: null },
          couponDiscount: { $gt: 0 }
        }
      },
      {
        $group: {
          _id: "$couponCode",
          usageCount: { $sum: 1 },
          totalDiscount: { $sum: "$couponDiscount" },
          totalRevenue: { $sum: "$totalAmount" },
          averageDiscount: { $avg: "$couponDiscount" }
        }
      },
      { $sort: { usageCount: -1 } }
    ]);

    const totalCouponStats = await Order.aggregate([
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          ordersWithCoupon: {
            $sum: { $cond: [{ $gt: ["$couponDiscount", 0] }, 1, 0] }
          },
          totalDiscountGiven: { $sum: "$couponDiscount" }
        }
      }
    ]);

    const stats = totalCouponStats[0] || {
      totalOrders: 0,
      ordersWithCoupon: 0,
      totalDiscountGiven: 0
    };

    res.status(200).json({
      success: true,
      data: {
        couponBreakdown: couponReport,
        summary: {
          ...stats,
          couponUsageRate: stats.totalOrders > 0
            ? ((stats.ordersWithCoupon / stats.totalOrders) * 100).toFixed(2) + "%"
            : "0%"
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching coupon usage report",
      error: error.message
    });
  }
};

// ===== TIME SLOT ANALYSIS =====
export const getTimeSlotAnalysis = async (req, res) => {
  try {
    const timeSlotReport = await Order.aggregate([
      {
        $match: {
          DeliveryTimeSlot: { $ne: null }
        }
      },
      {
        $group: {
          _id: "$DeliveryTimeSlot",
          count: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
          averageOrderValue: { $avg: "$totalAmount" }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: timeSlotReport
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching time slot analysis",
      error: error.message
    });
  }
};

// ===== ORDER TYPE REPORT (Basket vs Custom) =====
export const getOrderTypeReport = async (req, res) => {
  try {
    const orderTypeReport = await Order.aggregate([
      {
        $group: {
          _id: "$orderType",
          count: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
          averageOrderValue: { $avg: "$totalAmount" }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: orderTypeReport
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching order type report",
      error: error.message
    });
  }
};

// ===== MONTHLY TRENDS =====
export const getMonthlyTrends = async (req, res) => {
  try {
    const { months = 6 } = req.query;
    
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - parseInt(months));

    const trends = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          totalOrders: { $sum: 1 },
          totalRevenue: { $sum: "$totalAmount" },
          averageOrderValue: { $avg: "$totalAmount" },
          deliveredOrders: {
            $sum: { $cond: [{ $eq: ["$orderStatus", "delivered"] }, 1, 0] }
          }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    res.status(200).json({
      success: true,
      data: trends
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching monthly trends",
      error: error.message
    });
  }
};