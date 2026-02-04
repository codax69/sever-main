// utils/walletHelpers.js
import mongoose from 'mongoose';

/**
 * Convert rupees to paise
 * @param {number} rupees 
 * @returns {number} paise
 */
export const rupeeToPaise = (rupees) => {
  if (typeof rupees !== 'number' || isNaN(rupees)) {
    throw new Error('Invalid amount: must be a number');
  }
  
  if (rupees < 0) {
    throw new Error('Amount cannot be negative');
  }
  
  const paise = Math.round(rupees * 100);
  
  if (!Number.isInteger(paise)) {
    throw new Error('Invalid amount precision');
  }
  
  return paise;
};

/**
 * Convert paise to rupees
 * @param {number} paise 
 * @returns {number} rupees
 */
export const paiseToRupee = (paise) => {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new Error('Invalid paise amount');
  }
  
  return paise / 100;
};

/**
 * Validate reference ID format based on source
 * @param {string} referenceId 
 * @param {string} source 
 * @returns {boolean}
 */
export const validateReferenceId = (referenceId, source) => {
  const patterns = {
    order_payment: /^ORD_/,
    refund: /^REF_/,
    promo: /^PROMO_/,
    reversal: /^REV_/,
    adjustment: /^ADJ_/,
    cashback: /^CASH_/
  };
  
  const pattern = patterns[source];
  
  if (!pattern) {
    return true; // No specific pattern required
  }
  
  return pattern.test(referenceId);
};

/**
 * Generate reference ID
 * @param {string} prefix 
 * @returns {string}
 */
export const generateReferenceId = (prefix) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}_${timestamp}_${random}`;
};

/**
 * Check if MongoDB is running as replica set
 * @param {object} mongoose 
 * @returns {Promise<boolean>}
 */
export const checkReplicaSet = async (mongooseInstance) => {
  try {
    const admin = mongooseInstance.connection.db.admin();
    const status = await admin.replSetGetStatus();
    return !!status;
  } catch (error) {
    return false;
  }
};

/**
 * Format transaction for response
 * @param {object} transaction 
 * @returns {object}
 */
export const formatTransaction = (transaction) => {
  return {
    id: transaction._id,
    type: transaction.type,
    source: transaction.source,
    referenceId: transaction.referenceId,
    amount: paiseToRupee(transaction.amount),
    openingBalance: paiseToRupee(transaction.openingBalance),
    closingBalance: paiseToRupee(transaction.closingBalance),
    status: transaction.status,
    description: transaction.description,
    metadata: transaction.metadata,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt
  };
};

/**
 * Format multiple transactions for response
 * @param {Array} transactions 
 * @returns {Array}
 */
export const formatTransactions = (transactions) => {
  return transactions.map(formatTransaction);
};

/**
 * Validate wallet transaction before processing
 * @param {object} params 
 * @returns {object}
 */
export const validateWalletTransaction = (params) => {
  const { type, source, amount, referenceId } = params;

  // Validate type
  if (!['credit', 'debit'].includes(type)) {
    throw new Error('Invalid transaction type');
  }

  // Validate source
  const validSources = ['refund', 'promo', 'order_payment', 'reversal', 'adjustment', 'cashback'];
  if (!validSources.includes(source)) {
    throw new Error('Invalid transaction source');
  }

  // Validate amount
  if (typeof amount !== 'number' || amount <= 0) {
    throw new Error('Amount must be a positive number');
  }

  // Validate reference ID format
  if (!validateReferenceId(referenceId, source)) {
    throw new Error(`Invalid reference ID format for source: ${source}`);
  }

  return true;
};

/**
 * Calculate wallet balance from transactions
 * @param {Array} transactions 
 * @returns {number}
 */
export const calculateBalanceFromTransactions = (transactions) => {
  if (!transactions || transactions.length === 0) {
    return 0;
  }

  return transactions.reduce((balance, txn) => {
    if (txn.status !== 'success') return balance;
    
    if (txn.type === 'credit') {
      return balance + txn.amount;
    } else if (txn.type === 'debit') {
      return balance - txn.amount;
    }
    return balance;
  }, 0);
};

/**
 * Generate wallet transaction description
 * @param {string} type 
 * @param {string} source 
 * @param {string} referenceId 
 * @returns {string}
 */
export const generateTransactionDescription = (type, source, referenceId) => {
  const descriptions = {
    credit: {
      refund: `Refund for order ${referenceId}`,
      promo: `Promotional credit - ${referenceId}`,
      reversal: `Payment reversal - ${referenceId}`,
      adjustment: `Balance adjustment - ${referenceId}`,
      cashback: `Cashback earned - ${referenceId}`
    },
    debit: {
      order_payment: `Payment for order ${referenceId}`,
      adjustment: `Balance adjustment - ${referenceId}`
    }
  };

  return descriptions[type]?.[source] || `${type} - ${source}`;
};

/**
 * Check if wallet can perform transaction
 * @param {object} wallet 
 * @param {number} amount 
 * @param {string} type 
 * @returns {boolean}
 */
export const canPerformTransaction = (wallet, amount, type) => {
  if (!wallet || wallet.status !== 'active') {
    return false;
  }

  if (type === 'debit' && amount > 0) {
    // Balance check will be done in the transaction itself
    return true;
  }

  if (type === 'credit') {
    return true;
  }

  return false;
};

/**
 * Get transaction type badge/label
 * @param {string} type 
 * @returns {object}
 */
export const getTransactionBadge = (type) => {
  const badges = {
    credit: {
      label: 'Credit',
      color: 'green',
      icon: '+'
    },
    debit: {
      label: 'Debit',
      color: 'red',
      icon: '-'
    }
  };

  return badges[type] || { label: 'Unknown', color: 'gray', icon: '' };
};

/**
 * Get transaction source label
 * @param {string} source 
 * @returns {string}
 */
export const getSourceLabel = (source) => {
  const labels = {
    refund: 'Refund',
    promo: 'Promotional Credit',
    order_payment: 'Order Payment',
    reversal: 'Payment Reversal',
    adjustment: 'Admin Adjustment',
    cashback: 'Cashback'
  };

  return labels[source] || source;
};

/**
 * Sanitize wallet data for response
 * @param {object} wallet 
 * @param {number} balance 
 * @returns {object}
 */
export const sanitizeWalletResponse = (wallet, balance) => {
  return {
    id: wallet._id,
    userId: wallet.userId,
    balance: paiseToRupee(balance),
    balanceInPaise: balance,
    status: wallet.status,
    isActive: wallet.status === 'active',
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt
  };
};

/**
 * Validate transaction amount limits
 * @param {number} amount - Amount in paise
 * @param {string} type 
 * @returns {boolean}
 */
export const validateTransactionLimits = (amount, type) => {
  const limits = {
    credit: {
      min: 1, // 0.01 rupees
      max: 10000000 // 100,000 rupees
    },
    debit: {
      min: 1,
      max: 10000000
    }
  };

  const limit = limits[type];
  
  if (!limit) {
    throw new Error('Invalid transaction type');
  }

  if (amount < limit.min) {
    throw new Error(`Amount must be at least ₹${paiseToRupee(limit.min)}`);
  }

  if (amount > limit.max) {
    throw new Error(`Amount cannot exceed ₹${paiseToRupee(limit.max)}`);
  }

  return true;
};

/**
 * Create wallet transaction metadata
 * @param {object} additionalData 
 * @returns {object}
 */
export const createTransactionMetadata = (additionalData = {}) => {
  return {
    timestamp: new Date().toISOString(),
    ...additionalData
  };
};

/**
 * Check duplicate transaction
 * @param {object} WalletTransaction - Mongoose model
 * @param {string} referenceId 
 * @param {string} source 
 * @returns {Promise<boolean>}
 */
export const checkDuplicateTransaction = async (WalletTransaction, referenceId, source) => {
  const existing = await WalletTransaction.findOne({
    referenceId,
    source,
    status: { $ne: 'reversed' }
  });

  return !!existing;
};

/**
 * Format wallet balance for display
 * @param {number} balance - Balance in paise
 * @returns {string}
 */
export const formatBalanceDisplay = (balance) => {
  const rupees = paiseToRupee(balance);
  return `₹${rupees.toFixed(2)}`;
};

/**
 * Get wallet transaction summary
 * @param {Array} transactions 
 * @returns {object}
 */
export const getTransactionSummary = (transactions) => {
  const summary = {
    totalCredits: 0,
    totalDebits: 0,
    netChange: 0,
    transactionCount: transactions.length,
    successfulTransactions: 0,
    reversedTransactions: 0
  };

  transactions.forEach(txn => {
    if (txn.status === 'success') {
      summary.successfulTransactions++;
      
      if (txn.type === 'credit') {
        summary.totalCredits += txn.amount;
      } else if (txn.type === 'debit') {
        summary.totalDebits += txn.amount;
      }
    } else if (txn.status === 'reversed') {
      summary.reversedTransactions++;
    }
  });

  summary.netChange = summary.totalCredits - summary.totalDebits;

  return {
    totalCredits: paiseToRupee(summary.totalCredits),
    totalDebits: paiseToRupee(summary.totalDebits),
    netChange: paiseToRupee(summary.netChange),
    transactionCount: summary.transactionCount,
    successfulTransactions: summary.successfulTransactions,
    reversedTransactions: summary.reversedTransactions
  };
};

export default {
  rupeeToPaise,
  paiseToRupee,
  validateReferenceId,
  generateReferenceId,
  checkReplicaSet,
  formatTransaction,
  formatTransactions,
  validateWalletTransaction,
  calculateBalanceFromTransactions,
  generateTransactionDescription,
  canPerformTransaction,
  getTransactionBadge,
  getSourceLabel,
  sanitizeWalletResponse,
  validateTransactionLimits,
  createTransactionMetadata,
  checkDuplicateTransaction,
  formatBalanceDisplay,
  getTransactionSummary
};