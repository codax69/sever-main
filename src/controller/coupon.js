import Coupon from "../Model/coupon.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";

// Validate coupon code
export const validateCoupon = asyncHandler(async (req, res) => {
  const { code, subtotal, customerId } = req.body;

  if (!code || !subtotal) {
    throw new ApiError(400, "Coupon code and subtotal are required");
  }

  if (subtotal <= 0) {
    throw new ApiError(400, "Subtotal must be greater than 0");
  }

  // Find coupon by code (case-insensitive)
  const coupon = await Coupon.findOne({
    code: code.toUpperCase(),
    isActive: true,
  });

  if (!coupon) {
    throw new ApiError(404, "Invalid or expired coupon code");
  }

  // Check if coupon is expired
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    throw new ApiError(400, "This coupon has expired");
  }

  // Check minimum order amount
  if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount) {
    throw new ApiError(
      400,
      `Minimum order amount of ₹${coupon.minOrderAmount} required for this coupon`
    );
  }

  // Check usage limit
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw new ApiError(400, "This coupon has reached its usage limit");
  }

  // Check per-user usage limit
  if (customerId && coupon.perUserLimit) {
    const userUsageCount =
      coupon.usedBy?.filter((id) => id.toString() === customerId).length || 0;

    if (userUsageCount >= coupon.perUserLimit) {
      throw new ApiError(
        400,
        "You have already used this coupon the maximum number of times"
      );
    }
  }

  // Calculate discount
  let discountAmount = 0;
  if (coupon.discountType === "percentage") {
    discountAmount = (subtotal * coupon.discountValue) / 100;

    // Apply max discount cap if exists
    if (coupon.maxDiscount && discountAmount > coupon.maxDiscount) {
      discountAmount = coupon.maxDiscount;
    }
  } else if (coupon.discountType === "fixed") {
    discountAmount = coupon.discountValue;

    // Discount cannot exceed subtotal
    if (discountAmount > subtotal) {
      discountAmount = subtotal;
    }
  }

  discountAmount = Math.round(discountAmount * 100) / 100; // Round to 2 decimals

  res.json(
    new ApiResponse(
      200,
      {
        valid: true,
        coupon: {
          code: coupon.code,
          description: coupon.description,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue,
          maxDiscount: coupon.maxDiscount,
        },
        discountAmount,
        finalAmount: subtotal - discountAmount,
      },
      "Coupon validated successfully"
    )
  );
});

// Apply coupon to order and calculate final price
export const applyCoupon = asyncHandler(async (req, res) => {
  const { code, subtotal, deliveryCharges = 0, customerId } = req.body;

  if (!code || !subtotal) {
    throw new ApiError(400, "Coupon code and subtotal are required");
  }

  // Validate coupon first
  const coupon = await Coupon.findOne({
    code: code.toUpperCase(),
    isActive: true,
  });

  if (!coupon) {
    throw new ApiError(404, "Invalid or expired coupon code");
  }

  // Check expiry
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    throw new ApiError(400, "This coupon has expired");
  }

  // Check minimum order amount
  if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount) {
    throw new ApiError(
      400,
      `Minimum order amount of ₹${coupon.minOrderAmount} required`
    );
  }

  // Check usage limits
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw new ApiError(400, "Coupon usage limit reached");
  }

  if (customerId && coupon.perUserLimit) {
    const userUsageCount =
      coupon.usedBy?.filter((id) => id.toString() === customerId).length || 0;

    if (userUsageCount >= coupon.perUserLimit) {
      throw new ApiError(
        400,
        "You have reached the usage limit for this coupon"
      );
    }
  }

  // Calculate discount
  let discountAmount = 0;
  if (coupon.discountType === "percentage") {
    discountAmount = (subtotal * coupon.discountValue) / 100;
    if (coupon.maxDiscount && discountAmount > coupon.maxDiscount) {
      discountAmount = coupon.maxDiscount;
    }
  } else {
    discountAmount = Math.min(coupon.discountValue, subtotal);
  }

  discountAmount = Math.round(discountAmount * 100) / 100;

  const totalAfterDiscount = subtotal - discountAmount;
  const finalTotal = totalAfterDiscount + deliveryCharges;

  res.json(
    new ApiResponse(
      200,
      {
        couponId: coupon._id,
        couponCode: coupon.code,
        pricing: {
          subtotal,
          discountAmount,
          totalAfterDiscount,
          deliveryCharges,
          finalTotal,
        },
        savings: discountAmount,
      },
      "Coupon applied successfully"
    )
  );
});

// Create a new coupon (Admin)
export const createCoupon = asyncHandler(async (req, res) => {
  const {
    code,
    description,
    discountType,
    discountValue,
    minOrderAmount,
    maxDiscount,
    expiryDate,
    usageLimit,
    perUserLimit,
    isActive,
  } = req.body;

  if (!code || !discountType || !discountValue) {
    throw new ApiError(
      400,
      "Code, discount type, and discount value are required"
    );
  }

  if (!["percentage", "fixed"].includes(discountType)) {
    throw new ApiError(400, "Discount type must be 'percentage' or 'fixed'");
  }

  if (discountValue <= 0) {
    throw new ApiError(400, "Discount value must be greater than 0");
  }

  if (discountType === "percentage" && discountValue > 100) {
    throw new ApiError(400, "Percentage discount cannot exceed 100%");
  }

  // Check if coupon code already exists
  const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
  if (existingCoupon) {
    throw new ApiError(409, "Coupon code already exists");
  }

  const coupon = await Coupon.create({
    code: code.toUpperCase(),
    description,
    discountType,
    discountValue,
    minOrderAmount: minOrderAmount || 0,
    maxDiscount: maxDiscount || null,
    expiryDate: expiryDate || null,
    usageLimit: usageLimit || null,
    perUserLimit: perUserLimit || null,
    isActive: isActive !== undefined ? isActive : true,
  });

  res.json(new ApiResponse(201, coupon, "Coupon created successfully"));
});

// Get all coupons
export const getCoupons = asyncHandler(async (req, res) => {
  const { isActive, page = 1, limit = 10 } = req.query;

  const filter = {};
  if (isActive !== undefined) {
    filter.isActive = isActive === "true";
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const coupons = await Coupon.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const totalCoupons = await Coupon.countDocuments(filter);

  res.json(
    new ApiResponse(
      200,
      {
        coupons,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCoupons / parseInt(limit)),
          totalCoupons,
          hasMore: skip + coupons.length < totalCoupons,
        },
      },
      "Coupons fetched successfully"
    )
  );
});

// Get coupon by ID
export const getCouponById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id.match(/^[0-9a-fA-F]{24}$/)) {
    throw new ApiError(400, "Invalid coupon ID");
  }

  const coupon = await Coupon.findById(id);

  if (!coupon) {
    throw new ApiError(404, "Coupon not found");
  }

  res.json(new ApiResponse(200, coupon, "Coupon fetched successfully"));
});

// Update coupon
export const updateCoupon = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id.match(/^[0-9a-fA-F]{24}$/)) {
    throw new ApiError(400, "Invalid coupon ID");
  }

  const updateData = { ...req.body };

  // Prevent updating certain fields
  delete updateData.usedCount;
  delete updateData.usedBy;

  if (updateData.code) {
    updateData.code = updateData.code.toUpperCase();
  }

  const coupon = await Coupon.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  });

  if (!coupon) {
    throw new ApiError(404, "Coupon not found");
  }

  res.json(new ApiResponse(200, coupon, "Coupon updated successfully"));
});

// Delete coupon
export const deleteCoupon = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!id.match(/^[0-9a-fA-F]{24}$/)) {
    throw new ApiError(400, "Invalid coupon ID");
  }

  const coupon = await Coupon.findByIdAndDelete(id);

  if (!coupon) {
    throw new ApiError(404, "Coupon not found");
  }

  res.json(new ApiResponse(200, coupon, "Coupon deleted successfully"));
});

// Increment coupon usage (called after successful order)
export const incrementCouponUsage = async (couponId, customerId) => {
  const updateData = {
    $inc: { usedCount: 1 },
  };

  if (customerId) {
    updateData.$push = { usedBy: customerId };
  }

  await Coupon.findByIdAndUpdate(couponId, updateData);
};
