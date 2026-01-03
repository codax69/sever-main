import User from "../Model/user.js";
import Order from "../Model/order.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";

// ============= OPTIMIZED DATA STRUCTURES FOR PERFORMANCE =============

// Order status priority for sorting
const ORDER_STATUS_PRIORITY = new Map([
  ["placed", 1],
  ["processed", 2],
  ["shipped", 3],
  ["delivered", 4],
  ["cancelled", 5]
]);

// Valid sort options for order history
const ORDER_SORT_OPTIONS = new Set(["date", "status", "total"]);

// Valid address types
const ADDRESS_TYPES = new Set(["home", "work", "other"]);

// Cache for user order counts (simple in-memory cache)
const userOrderCountCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper functions for cache
const getCachedOrderCount = (userId) => {
  const cached = userOrderCountCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.count;
  }
  return null;
};

const setCachedOrderCount = (userId, count) => {
  userOrderCountCache.set(userId, { count, timestamp: Date.now() });
};

// ============= ORDER HISTORY CONTROLLERS =============

// Get order history for current user with optimized queries and pagination
export const getOrderHistory = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const {
    page = 1,
    limit = 10,
    status,
    sortBy = "date",
    sortOrder = "desc",
    startDate,
    endDate
  } = req.query;

  // Validate sort options using Set for O(1) lookup
  if (!ORDER_SORT_OPTIONS.has(sortBy)) {
    throw new ApiError(400, "Invalid sort option. Use: date, status, or total");
  }

  // Build query with optimized indexing
  const query = { customer: userId };
  if (status) query.status = status;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  // Build sort object with priority mapping
  const sort = {};
  if (sortBy === "date") {
    sort.createdAt = sortOrder === "desc" ? -1 : 1;
  } else if (sortBy === "status") {
    // Custom sort using priority map
    sort.status = sortOrder === "desc" ? -1 : 1;
  } else if (sortBy === "total") {
    sort.totalAmount = sortOrder === "desc" ? -1 : 1;
  }

  // Check cache for total count
  let totalCount = getCachedOrderCount(userId);
  let orders;

  if (totalCount === null) {
    // Execute queries in parallel for better performance
    [orders, totalCount] = await Promise.all([
      Order.find(query)
        .populate("items.vegetable", "name image")
        .sort(sort)
        .skip((page - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(), // Use lean for better performance
      Order.countDocuments(query)
    ]);

    // Cache the count
    setCachedOrderCount(userId, totalCount);
  } else {
    // Use cached count, only fetch orders
    orders = await Order.find(query)
      .populate("items.vegetable", "name image")
      .sort(sort)
      .skip((page - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
  }

  // Calculate pagination info
  const totalPages = Math.ceil(totalCount / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  res.status(200).json(
    new ApiResponse(200, {
      orders,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalOrders: totalCount,
        hasNext,
        hasPrev,
        limit: parseInt(limit)
      }
    }, "Order history retrieved successfully")
  );
});

// ============= ADDRESS CONTROLLERS =============

// Get all addresses for current user
export const getAddresses = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const user = await User.findById(userId).select("addresses").lean();

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  res.status(200).json(
    new ApiResponse(200, {
      addresses: user.addresses || [],
      defaultAddress: user.addresses?.find(addr => addr.isDefault) || null
    }, "Addresses retrieved successfully")
  );
});

// Add new address for current user
export const addAddress = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { type, street, city, state, zipCode, country, isDefault } = req.body;

  // Validate required fields
  if (!street || !city || !state || !zipCode || !country) {
    throw new ApiError(400, "Street, city, state, zipCode, and country are required");
  }

  // Validate address type using Set
  if (type && !ADDRESS_TYPES.has(type)) {
    throw new ApiError(400, "Invalid address type. Use: home, work, or other");
  }

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  // If setting as default, unset other defaults
  if (isDefault) {
    user.addresses.forEach(addr => addr.isDefault = false);
  }

  // Add new address
  const newAddress = {
    type: type || "home",
    street: street.trim(),
    city: city.trim(),
    state: state.trim(),
    zipCode: zipCode.trim(),
    country: country.trim(),
    isDefault: isDefault || false
  };

  user.addresses.push(newAddress);
  await user.save();

  res.status(201).json(
    new ApiResponse(201, {
      address: newAddress,
      totalAddresses: user.addresses.length
    }, "Address added successfully")
  );
});

// Update address for current user
export const updateAddress = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { addressId } = req.params;
  const { type, street, city, state, zipCode, country, isDefault } = req.body;

  // Validate address type if provided
  if (type && !ADDRESS_TYPES.has(type)) {
    throw new ApiError(400, "Invalid address type. Use: home, work, or other");
  }

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);

  if (addressIndex === -1) {
    throw new ApiError(404, "Address not found");
  }

  // If setting as default, unset other defaults
  if (isDefault) {
    user.addresses.forEach(addr => addr.isDefault = false);
  }

  // Update address fields
  const address = user.addresses[addressIndex];
  if (type !== undefined) address.type = type;
  if (street !== undefined) address.street = street.trim();
  if (city !== undefined) address.city = city.trim();
  if (state !== undefined) address.state = state.trim();
  if (zipCode !== undefined) address.zipCode = zipCode.trim();
  if (country !== undefined) address.country = country.trim();
  if (isDefault !== undefined) address.isDefault = isDefault;

  await user.save();

  res.status(200).json(
    new ApiResponse(200, {
      address: user.addresses[addressIndex]
    }, "Address updated successfully")
  );
});

// Delete address for current user
export const deleteAddress = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { addressId } = req.params;

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);

  if (addressIndex === -1) {
    throw new ApiError(404, "Address not found");
  }

  // Prevent deletion if it's the only address
  if (user.addresses.length === 1) {
    throw new ApiError(400, "Cannot delete the only address. Add another address first.");
  }

  // If deleting default address, set another as default
  const wasDefault = user.addresses[addressIndex].isDefault;
  user.addresses.splice(addressIndex, 1);

  if (wasDefault && user.addresses.length > 0) {
    user.addresses[0].isDefault = true;
  }

  await user.save();

  res.status(200).json(
    new ApiResponse(200, {
      remainingAddresses: user.addresses.length,
      newDefaultAddress: wasDefault ? user.addresses.find(addr => addr.isDefault) : null
    }, "Address deleted successfully")
  );
});

// Set default address
export const setDefaultAddress = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { addressId } = req.params;

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);

  if (addressIndex === -1) {
    throw new ApiError(404, "Address not found");
  }

  // Unset all defaults and set the selected one
  user.addresses.forEach(addr => addr.isDefault = false);
  user.addresses[addressIndex].isDefault = true;

  await user.save();

  res.status(200).json(
    new ApiResponse(200, {
      address: user.addresses[addressIndex]
    }, "Default address set successfully")
  );
});