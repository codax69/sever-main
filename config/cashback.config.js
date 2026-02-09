/**
 * Cashback Configuration
 * Defines rules for automatic cashback credits to user wallets
 */

export const CASHBACK_CONFIG = {
  // Enable/disable cashback system
  enabled: true,

  // Minimum order amount to qualify for cashback (in rupees)
  minOrderAmount: 200,

  // Minimum completed orders required before cashback eligibility
  // Users will be randomly assigned a threshold between 2-4 orders
  minOrderCountRange: { min: 2, max: 4 },

  // Tiered cashback percentages based on order amount
  tiers: [
    { minAmount: 200, maxAmount: 500, percentage: 1.2 },
    { minAmount: 500, maxAmount: 1000, percentage: 1.5 },
    { minAmount: 1000, maxAmount: Infinity, percentage: 1.7 },
  ],

  // Minimum and maximum cashback amount per order (in rupees)
  minCashbackAmount: 5,
  maxCashbackAmount: 10,

  // Excluded payment methods (no cashback for these)
  excludedPaymentMethods: ["WALLET"], // No cashback for full wallet payments

  // When to credit cashback
  triggerOn: "placed", // Credit immediately when order is placed

  // Description template for wallet transaction
  descriptionTemplate: "Cashback for order {orderId}",
};

/**
 * Get minimum order count threshold for a user (consistent per user)
 * @param {string} userId - User ID
 * @returns {number} Minimum order count (2, 3, or 4)
 */
export function getMinOrderCountForUser(userId) {
  if (!userId) return CASHBACK_CONFIG.minOrderCountRange.max;

  // Simple hash function to get consistent value per user
  const userIdStr = userId.toString();
  let hash = 0;
  for (let i = 0; i < userIdStr.length; i++) {
    hash = (hash << 5) - hash + userIdStr.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Map hash to range [2, 4]
  const { min, max } = CASHBACK_CONFIG.minOrderCountRange;
  const range = max - min + 1;
  return min + (Math.abs(hash) % range);
}

/**
 * Calculate cashback amount for an order
 * @param {Object} order - Order object with finalPayableAmount and paymentMethod
 * @param {string} userId - User ID (optional, for order count validation)
 * @param {number} completedOrderCount - Number of completed orders by user (optional)
 * @returns {number} Cashback amount in rupees (0 if not eligible)
 */
export function calculateCashback(
  order,
  userId = null,
  completedOrderCount = 0,
) {
  // Check if cashback is enabled
  if (!CASHBACK_CONFIG.enabled) {
    return 0;
  }

  // Check if user has completed minimum required orders
  if (userId && completedOrderCount !== undefined) {
    const minOrdersRequired = getMinOrderCountForUser(userId);
    if (completedOrderCount < minOrdersRequired) {
      return 0;
    }
  }

  // Use finalPayableAmount (amount after wallet credit deduction)
  const orderAmount = order.finalPayableAmount || order.totalAmount;

  // Check minimum order amount
  if (orderAmount < CASHBACK_CONFIG.minOrderAmount) {
    return 0;
  }

  // Check if payment method is excluded
  if (CASHBACK_CONFIG.excludedPaymentMethods.includes(order.paymentMethod)) {
    return 0;
  }

  // Find applicable tier
  const tier = CASHBACK_CONFIG.tiers.find(
    (t) => orderAmount >= t.minAmount && orderAmount < t.maxAmount,
  );

  if (!tier) {
    return 0;
  }

  // Calculate cashback
  let cashback = (orderAmount * tier.percentage) / 100;

  // Apply minimum and maximum limits
  cashback = Math.max(cashback, CASHBACK_CONFIG.minCashbackAmount);
  cashback = Math.min(cashback, CASHBACK_CONFIG.maxCashbackAmount);

  // Round to 2 decimal places
  return Math.round(cashback * 100) / 100;
}

/**
 * Check if order is eligible for cashback
 * @param {Object} order - Order object
 * @returns {boolean} True if eligible
 */
export function isCashbackEligible(order) {
  return calculateCashback(order) > 0;
}
