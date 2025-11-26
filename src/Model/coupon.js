import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    discountType: {
      type: String,
      required: [true, "Discount type is required"],
      enum: {
        values: ["percentage", "fixed"],
        message: "Discount type must be either 'percentage' or 'fixed'",
      },
    },
    discountValue: {
      type: Number,
      required: [true, "Discount value is required"],
      min: [0, "Discount value cannot be negative"],
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: [0, "Minimum order amount cannot be negative"],
    },
    maxDiscount: {
      type: Number,
      default: null,
      min: [0, "Maximum discount cannot be negative"],
    },
    expiryDate: {
      type: Date,
      default: null,
    },
    usageLimit: {
      type: Number,
      default: null,
      min: [1, "Usage limit must be at least 1"],
    },
    perUserLimit: {
      type: Number,
      default: null,
      min: [1, "Per user limit must be at least 1"],
    },
    usedCount: {
      type: Number,
      default: 0,
      min: [0, "Used count cannot be negative"],
    },
    usedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Customer",
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Virtual to check if coupon is expired
couponSchema.virtual("isExpired").get(function () {
  if (!this.expiryDate) return false;
  return new Date(this.expiryDate) < new Date();
});

// Virtual to check if usage limit reached
couponSchema.virtual("isUsageLimitReached").get(function () {
  if (!this.usageLimit) return false;
  return this.usedCount >= this.usageLimit;
});

// Method to check if coupon is valid
couponSchema.methods.isValid = function () {
  if (!this.isActive) return false;
  if (this.isExpired) return false;
  if (this.isUsageLimitReached) return false;
  return true;
};

// Method to calculate discount amount
couponSchema.methods.calculateDiscount = function (subtotal) {
  if (this.minOrderAmount && subtotal < this.minOrderAmount) {
    throw new Error(
      `Minimum order amount of ₹${this.minOrderAmount} required`
    );
  }

  let discountAmount = 0;

  if (this.discountType === "percentage") {
    discountAmount = (subtotal * this.discountValue) / 100;
    
    if (this.maxDiscount && discountAmount > this.maxDiscount) {
      discountAmount = this.maxDiscount;
    }
  } else if (this.discountType === "fixed") {
    discountAmount = this.discountValue;
    
    if (discountAmount > subtotal) {
      discountAmount = subtotal;
    }
  }

  return Math.round(discountAmount * 100) / 100;
};

// Pre-save validation
couponSchema.pre("save", function (next) {
  if (this.discountType === "percentage" && this.discountValue > 100) {
    return next(new Error("Percentage discount cannot exceed 100%"));
  }
  next();
});

// Ensure virtuals are included when converting to JSON
couponSchema.set("toJSON", { virtuals: true });
couponSchema.set("toObject", { virtuals: true });

const Coupon = mongoose.model("Coupon", couponSchema);

export default Coupon;