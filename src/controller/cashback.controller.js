import Wallet from "../Model/wallet.model.js";
import WalletTransaction from "../Model/walletTransaction.model.js";
import Order from "../Model/order.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";
import { paiseToRupee } from "../utility/walletHelpers.js";

/**
 * @desc    Get user's total cashback earned
 * @route   GET /api/cashback/summary
 * @access  Private
 */
export const getCashbackSummary = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  // Get all cashback transactions
  const cashbackTransactions = await WalletTransaction.find({
    walletId: wallet._id,
    source: "cashback",
    status: "success",
  });

  // Calculate total cashback earned
  const totalCashbackInPaise = cashbackTransactions.reduce(
    (sum, txn) => sum + txn.amount,
    0,
  );

  // Get count of orders with cashback
  // ✅ BUG-C2 Fix: field is `customerInfo` not `customerId` in Order schema
  const ordersWithCashback = await Order.countDocuments({
    customerInfo: userId,
    cashbackCredited: true,
  });

  // ✅ BUG-M1 Fix: sort so lastCashbackDate reflects the truly newest transaction
  const sortedTransactions = [...cashbackTransactions].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  res.status(200).json(
    new ApiResponse(
      200,
      {
        totalCashbackEarned: paiseToRupee(totalCashbackInPaise),
        totalCashbackTransactions: cashbackTransactions.length,
        ordersWithCashback,
        lastCashbackDate:
          sortedTransactions.length > 0
            ? sortedTransactions[0].createdAt
            : null,
      },
      "Cashback summary fetched successfully",
    ),
  );
});

/**
 * @desc    Get user's cashback transaction history
 * @route   GET /api/cashback/history
 * @access  Private
 */
export const getCashbackHistory = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { page = 1, limit = 20 } = req.query;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Get cashback transactions with pagination
  const [transactions, total] = await Promise.all([
    WalletTransaction.find({
      walletId: wallet._id,
      source: "cashback",
      status: "success",
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    WalletTransaction.countDocuments({
      walletId: wallet._id,
      source: "cashback",
      status: "success",
    }),
  ]);

  // ✅ BUG-C4 Fix: Replaced N+1 sequential Order.findOne calls with a single batch query
  // Extract all order IDs from reference IDs (format: CASH_{orderId})
  const orderIdList = transactions
    .map((txn) => txn.referenceId?.replace("CASH_", ""))
    .filter(Boolean);

  // Single DB call to get all orders at once
  const ordersMap = new Map();
  if (orderIdList.length > 0) {
    const ordersFound = await Order.find(
      { orderId: { $in: orderIdList } },
      "orderId totalAmount finalPayableAmount createdAt"
    ).lean();
    ordersFound.forEach((o) => ordersMap.set(o.orderId, o));
  }

  const formattedTransactions = transactions.map((txn) => {
    const orderId = txn.referenceId?.replace("CASH_", "");
    const order = orderId ? ordersMap.get(orderId) : null;

    return {
      id: txn._id,
      amount: paiseToRupee(txn.amount),
      description: txn.description,
      referenceId: txn.referenceId,
      createdAt: txn.createdAt,
      orderDetails: order
        ? {
            orderId: order.orderId,
            orderAmount: order.totalAmount,
            finalAmount: order.finalPayableAmount,
            orderDate: order.createdAt,
          }
        : null,
    };
  });

  res.status(200).json(
    new ApiResponse(
      200,
      {
        transactions: formattedTransactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total,
          itemsPerPage: parseInt(limit),
        },
      },
      "Cashback history fetched successfully",
    ),
  );
});

/**
 * @desc    Get cashback details for a specific order
 * @route   GET /api/cashback/order/:orderId
 * @access  Private
 */
export const getOrderCashback = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { orderId } = req.params;

  // Find the order
  // ✅ BUG-C2 Fix: field is `customerInfo` not `customerId` in Order schema
  const order = await Order.findOne({
    orderId,
    customerInfo: userId,
  }).select(
    "orderId totalAmount finalPayableAmount cashbackEligible cashbackAmount cashbackCredited cashbackCreditedAt paymentMethod createdAt",
  );

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  // Get cashback transaction if credited
  let cashbackTransaction = null;
  if (order.cashbackCredited) {
    const wallet = await Wallet.findByUserId(userId);
    if (wallet) {
      const txn = await WalletTransaction.findOne({
        walletId: wallet._id,
        source: "cashback",
        referenceId: `CASH_${orderId}`,
        status: "success",
      });

      if (txn) {
        cashbackTransaction = {
          id: txn._id,
          amount: paiseToRupee(txn.amount),
          creditedAt: txn.createdAt,
          description: txn.description,
        };
      }
    }
  }

  res.status(200).json(
    new ApiResponse(
      200,
      {
        orderId: order.orderId,
        orderAmount: order.totalAmount,
        finalAmount: order.finalPayableAmount,
        paymentMethod: order.paymentMethod,
        orderDate: order.createdAt,
        cashback: {
          eligible: order.cashbackEligible,
          amount: order.cashbackAmount,
          credited: order.cashbackCredited,
          creditedAt: order.cashbackCreditedAt,
          transaction: cashbackTransaction,
        },
      },
      "Order cashback details fetched successfully",
    ),
  );
});

/**
 * @desc    Get recent cashback notifications (last 5 cashbacks)
 * @route   GET /api/cashback/recent
 * @access  Private
 */
export const getRecentCashback = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  // Get last 5 cashback transactions
  const recentCashback = await WalletTransaction.find({
    walletId: wallet._id,
    source: "cashback",
    status: "success",
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  const formatted = recentCashback.map((txn) => ({
    id: txn._id,
    amount: paiseToRupee(txn.amount),
    description: txn.description,
    createdAt: txn.createdAt,
    referenceId: txn.referenceId,
  }));

  res.status(200).json(
    new ApiResponse(
      200,
      {
        recentCashback: formatted,
      },
      "Recent cashback fetched successfully",
    ),
  );
});
