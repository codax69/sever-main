import User from "../Model/user.js";
import Order from "../Model/order.js";
import Address from "../Model/address.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";

const ORDER_STATUS_PRIORITY = new Map([
  ["placed", 1],
  ["processed", 2],
  ["shipped", 3],
  ["delivered", 4],
  ["cancelled", 5],
]);

const ORDER_SORT_OPTIONS = new Set(["date", "status", "total"]);

const ADDRESS_TYPES = new Set(["home", "work", "other"]);

const userOrderCountCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

export const getUser = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  // console.log(userId);
  const user = await User.findById(userId)
    .select("-password -refreshToken")
    .lean();

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  res
    .status(200)
    .json(new ApiResponse(200, { user }, "User retrieved successfully"));
});

export const getOrderHistory = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  // console.log(userId);

  const {
    page = 1,
    limit = 10,
    status,
    sortBy = "date",
    sortOrder = "desc",
    startDate,
    endDate,
  } = req.query;

  if (!ORDER_SORT_OPTIONS.has(sortBy)) {
    throw new ApiError(400, "Invalid sort option. Use: date, status, or total");
  }

  const user = await User.findById(userId).select("orders").lean();

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const query = { _id: { $in: user.orders || [] } };

  if (status) query.orderStatus = status;
  if (startDate || endDate) {
    query.orderDate = {};
    if (startDate) query.orderDate.$gte = new Date(startDate);
    if (endDate) query.orderDate.$lte = new Date(endDate);
  }

  const sort = {};
  if (sortBy === "date") {
    sort.orderDate = sortOrder === "desc" ? -1 : 1;
  } else if (sortBy === "status") {
    sort.orderStatus = sortOrder === "desc" ? -1 : 1;
  } else if (sortBy === "total") {
    sort.totalAmount = sortOrder === "desc" ? -1 : 1;
  }

  let totalCount = getCachedOrderCount(userId);
  let orders;

  if (totalCount === null) {
    [orders, totalCount] = await Promise.all([
      Order.find(query)
        .populate("selectedVegetables.vegetable", "name image")
        .populate("selectedOffer", "name price")
        .sort(sort)
        .skip((page - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(query),
    ]);

    setCachedOrderCount(userId, totalCount);
  } else {
    orders = await Order.find(query)
      .populate("selectedVegetables.vegetable", "name image")
      .populate("selectedOffer", "name price")
      .sort(sort)
      .skip((page - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean();
  }

  const totalPages = Math.ceil(totalCount / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        orders,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalOrders: totalCount,
          hasNext,
          hasPrev,
          limit: parseInt(limit),
        },
      },
      "Order history retrieved successfully",
    ),
  );
});

export const getUserOrderHistory = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  if (!userId) {
    throw new ApiError(400, "User ID required");
  }

  const user = await User.findById(userId).select("orders").lean();

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const total = user.orders?.length || 0;

  const orders = await Order.find({ _id: { $in: user.orders || [] } }, null, {
    lean: true,
  })
    .populate("selectedOffer", "name price")
    .populate("selectedVegetables.vegetable", "name image")
    .sort({ orderDate: -1 })
    .skip(skip)
    .limit(limit);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        orders,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalOrders: total,
          hasMore: page * limit < total,
        },
      },
      "Order history fetched successfully",
    ),
  );
});

export const getUserAddresses = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Find all addresses for this user
  const addresses = await Address.find({ user: userId })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  // Get the default address
  const defaultAddress = addresses.find((addr) => addr.isDefault) || null;

  res.status(200).json(
    new ApiResponse(
      200,
      {
        addresses,
        total: addresses.length,
        defaultAddress,
      },
      "User addresses retrieved successfully",
    ),
  );
});
