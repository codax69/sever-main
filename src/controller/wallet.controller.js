import Wallet from "../Model/wallet.model.js";
import WalletTransaction from "../Model/walletTransaction.model.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";
import {
  rupeeToPaise,
  paiseToRupee,
  formatTransaction,
  generateReferenceId,
} from "../utility/walletHelpers.js";
import mongoose from "mongoose";

/**
 * @desc    Get user wallet
 * @route   GET /api/wallet
 * @access  Private
 */
export const getWallet = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  const balance = await WalletTransaction.getCurrentBalance(wallet._id);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        wallet: {
          id: wallet._id,
          userId: wallet.userId,
          balance: paiseToRupee(balance),
          status: wallet.status,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        },
      },
      "Wallet fetched successfully",
    ),
  );
});

/**
 * @desc    Create wallet for user
 * @route   POST /api/wallet
 * @access  Private
 */
export const createWallet = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const existingWallet = await Wallet.findByUserId(userId);

  if (existingWallet) {
    throw new ApiError(400, "Wallet already exists");
  }

  const wallet = await Wallet.createWallet(userId);

  res.status(201).json(
    new ApiResponse(
      201,
      {
        wallet: {
          id: wallet._id,
          userId: wallet.userId,
          balance: 0,
          status: wallet.status,
          createdAt: wallet.createdAt,
        },
      },
      "Wallet created successfully",
    ),
  );
});

/**
 * @desc    Get wallet transaction history
 * @route   GET /api/wallet/transactions
 * @access  Private
 */
export const getTransactionHistory = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { page = 1, limit = 20, type, source } = req.query;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  const result = await WalletTransaction.getTransactionHistory(wallet._id, {
    page: parseInt(page),
    limit: parseInt(limit),
    type,
    source,
  });

  const formattedTransactions = result.transactions.map(formatTransaction);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        transactions: formattedTransactions,
        pagination: result.pagination,
      },
      "Transaction history fetched successfully",
    ),
  );
});

/**
 * @desc    Credit wallet (Admin only)
 * @route   POST /api/wallet/credit
 * @access  Private/Admin
 */
export const creditWallet = asyncHandler(async (req, res) => {
  const { userId, source, referenceId, amount, description } = req.body;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  if (!wallet.isActive()) {
    throw new ApiError(400, "Wallet is not active");
  }

  const amountInPaise = rupeeToPaise(amount);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const transaction = await WalletTransaction.createCreditTransaction(
      wallet._id,
      source,
      referenceId,
      amountInPaise,
      description,
      session,
    );

    await session.commitTransaction();

    res.status(201).json(
      new ApiResponse(
        201,
        {
          transaction: formatTransaction(transaction[0]),
        },
        "Wallet credited successfully",
      ),
    );
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

/**
 * @desc    Debit wallet (Internal use - called from order controller)
 * @route   POST /api/wallet/debit
 * @access  Private/Internal
 */
export const debitWallet = asyncHandler(async (req, res) => {
  const { userId, source, referenceId, amount, description } = req.body;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  if (!wallet.isActive()) {
    throw new ApiError(400, "Wallet is not active");
  }

  const amountInPaise = rupeeToPaise(amount);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const currentBalance = await WalletTransaction.getCurrentBalance(
      wallet._id,
      session,
    );

    if (currentBalance < amountInPaise) {
      throw new ApiError(400, "Insufficient wallet balance");
    }

    const transaction = await WalletTransaction.createDebitTransaction(
      wallet._id,
      source,
      referenceId,
      amountInPaise,
      description,
      session,
    );

    await session.commitTransaction();

    res.status(201).json(
      new ApiResponse(
        201,
        {
          transaction: formatTransaction(transaction[0]),
        },
        "Wallet debited successfully",
      ),
    );
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

/**
 * @desc    Update wallet status (Admin only)
 * @route   PATCH /api/wallet/:walletId/status
 * @access  Private/Admin
 */
export const updateWalletStatus = asyncHandler(async (req, res) => {
  const { walletId } = req.params;
  const { status } = req.body;

  const wallet = await Wallet.findById(walletId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  wallet.status = status;
  await wallet.save();

  res.status(200).json(
    new ApiResponse(
      200,
      {
        wallet: {
          id: wallet._id,
          userId: wallet.userId,
          status: wallet.status,
          updatedAt: wallet.updatedAt,
        },
      },
      "Wallet status updated successfully",
    ),
  );
});

/**
 * @desc    Reverse a transaction (Admin only)
 * @route   POST /api/wallet/transactions/:transactionId/reverse
 * @access  Private/Admin
 */
export const reverseTransaction = asyncHandler(async (req, res) => {
  const { transactionId } = req.params;

  const transaction = await WalletTransaction.findById(transactionId);

  if (!transaction) {
    throw new ApiError(404, "Transaction not found");
  }

  if (transaction.status === "reversed") {
    throw new ApiError(400, "Transaction already reversed");
  }

  if (transaction.type !== "debit") {
    throw new ApiError(400, "Only debit transactions can be reversed");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const reversalTxn = await transaction.reverse(session);

    await session.commitTransaction();

    res.status(201).json(
      new ApiResponse(
        201,
        {
          originalTransaction: formatTransaction(transaction),
          reversalTransaction: formatTransaction(reversalTxn),
        },
        "Transaction reversed successfully",
      ),
    );
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

/**
 * @desc    Check wallet balance (used internally in order flow)
 * @route   GET /api/wallet/balance
 * @access  Private
 */
export const checkBalance = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  const balance = await WalletTransaction.getCurrentBalance(wallet._id);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        balance: paiseToRupee(balance),
        balanceInPaise: balance,
        isActive: wallet.isActive(),
      },
      "Balance fetched successfully",
    ),
  );
});

/**
 * @desc    Get wallet statistics (Admin only)
 * @route   GET /api/wallet/stats
 * @access  Private/Admin
 */
export const getWalletStats = asyncHandler(async (req, res) => {
  const { userId } = req.query;

  const wallet = await Wallet.findByUserId(userId);

  if (!wallet) {
    throw new ApiError(404, "Wallet not found");
  }

  const [totalCredits, totalDebits, transactionCount, currentBalance] =
    await Promise.all([
      WalletTransaction.aggregate([
        { $match: { walletId: wallet._id, type: "credit", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      WalletTransaction.aggregate([
        { $match: { walletId: wallet._id, type: "debit", status: "success" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      WalletTransaction.countDocuments({ walletId: wallet._id }),
      WalletTransaction.getCurrentBalance(wallet._id),
    ]);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        stats: {
          currentBalance: paiseToRupee(currentBalance),
          totalCredits: paiseToRupee(totalCredits[0]?.total || 0),
          totalDebits: paiseToRupee(totalDebits[0]?.total || 0),
          transactionCount,
          walletStatus: wallet.status,
        },
      },
      "Wallet statistics fetched successfully",
    ),
  );
});
