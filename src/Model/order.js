import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    orderType: {
      type: String,
      enum: ["basket", "custom"],
      required: true,
      default: "custom",
    },

    customerInfo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    deliveryAddressId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      required: false,
      default: null,
    },

    selectedBasket: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Basket",
      required: function () {
        return this.orderType === "basket";
      },
    },

    selectedVegetables: [
      {
        vegetable: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Vegetable",
          required: true,
        },
        weight: {
          type: String,
          required: true,
          validate: {
            validator: function (v) {
              return /^\d+(kg|g)$/.test(v) || /^set\d+$/.test(v);
            },
            message: (props) =>
              `${props.value} is not a valid weight (e.g., 1kg, 500g) or set format (e.g., set0, set1)!`,
          },
        },
        quantity: {
          type: Number,
          required: true,
          min: [1, "Quantity must be at least 1"],
          default: 1,
        },
        pricePerUnit: {
          type: Number,
          required: true,
          min: [0, "Price must be greater than or equal to 0"],
        },
        subtotal: {
          type: Number,
          required: true,
          min: [0, "Subtotal must be greater than or equal to 0"],
        },
        isFromBasket: {
          type: Boolean,
          default: false,
        },
        setIndex: {
          type: Number,
          min: 0,
        },
        setLabel: {
          type: String,
        },
        setQuantity: {
          type: Number,
          min: 1,
        },
        setUnit: {
          type: String,
          enum: ["pieces", "bundles", "sets", "nos"],
        },
      },
    ],

    orderDate: {
      type: Date,
      default: Date.now,
    },

    vegetablesTotal: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    basketPrice: {
      type: Number,
      min: 0,
      default: 0,
    },

    couponCode: {
      type: String,
      uppercase: true,
      trim: true,
      default: null,
    },

    couponId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
      default: null,
    },

    couponDiscount: {
      type: Number,
      min: [0, "Coupon discount cannot be negative"],
      default: 0,
    },

    subtotalAfterDiscount: {
      type: Number,
      required: true,
      min: [0, "Subtotal after discount cannot be negative"],
    },

    discount: {
      type: Number,
      min: 0,
      default: 0,
    },

    deliveryCharges: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    walletCreditUsed: {
      type: Number,
      min: 0,
      default: 0,
    },

    finalPayableAmount: {
      type: Number,
      required: true,
      min: 0,
      default: function () {
        return this.totalAmount || 0;
      },
    },

    cashbackEligible: {
      type: Boolean,
      default: false,
    },

    cashbackAmount: {
      type: Number,
      min: 0,
      default: 0,
    },

    cashbackCredited: {
      type: Boolean,
      default: false,
    },

    cashbackCreditedAt: {
      type: Date,
      default: null,
    },

    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    paymentMethod: {
      type: String,
      enum: ["COD", "ONLINE", "WALLET"],
      required: true,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "awaiting_payment", "completed", "failed"],
      default: "pending",
    },

    orderStatus: {
      type: String,
      enum: ["placed", "processed", "shipped", "delivered", "cancelled"],
      default: "placed",
    },

    DeliveryTimeSlot: {
      type: String,
      enum: ["8AM-10AM", "4PM-6PM"],
      default: null,
    },

    specialInstructions: {
      type: String,
      trim: true,
      default: null,
    },

    razorpayOrderId: {
      type: String,
      default: null,
    },

    razorpayPaymentId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ===== VIRTUALS =====
orderSchema.virtual("totalItems").get(function () {
  return this.selectedVegetables.reduce((sum, item) => sum + item.quantity, 0);
});

orderSchema.virtual("uniqueVegetablesCount").get(function () {
  return this.selectedVegetables.length;
});

orderSchema.virtual("hasCoupon").get(function () {
  return this.couponDiscount > 0 && this.couponCode != null;
});

orderSchema.virtual("totalSavings").get(function () {
  let savings = this.couponDiscount || 0;
  const DELIVERY_CHARGES = 30;
  if (this.deliveryCharges === 0 && this.subtotalAfterDiscount > 250) {
    savings += DELIVERY_CHARGES;
  }
  return savings;
});

// ===== PRE-SAVE VALIDATION =====
orderSchema.pre("save", function (next) {
  try {
    const areEqual = (a, b, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

    const calculatedVegTotal = this.selectedVegetables.reduce(
      (sum, item) => sum + (item.subtotal || 0),
      0,
    );

    if (this.orderType === "custom") {
      if (!areEqual(this.vegetablesTotal, calculatedVegTotal)) {
        console.error(
          `❌ Vegetables total mismatch: Expected ${calculatedVegTotal.toFixed(2)}, got ${this.vegetablesTotal.toFixed(2)}`,
        );
        return next(
          new Error(
            `Vegetables total mismatch. Expected ${calculatedVegTotal.toFixed(2)}, got ${this.vegetablesTotal.toFixed(2)}`,
          ),
        );
      }
    }

    if (this.couponDiscount < 0) {
      return next(new Error("Coupon discount cannot be negative"));
    }

    let expectedSubtotal;
    if (this.orderType === "basket") {
      expectedSubtotal = Math.max(0, this.basketPrice - this.couponDiscount);
    } else {
      expectedSubtotal = Math.max(
        0,
        this.vegetablesTotal - this.couponDiscount,
      );
    }

    if (!areEqual(this.subtotalAfterDiscount, expectedSubtotal)) {
      console.error(
        `❌ Subtotal mismatch: Expected ${expectedSubtotal.toFixed(2)}, got ${this.subtotalAfterDiscount.toFixed(2)}`,
      );
      return next(
        new Error(
          `Subtotal after discount mismatch. Expected ${expectedSubtotal.toFixed(2)}, got ${this.subtotalAfterDiscount.toFixed(2)}`,
        ),
      );
    }

    const calculatedTotal = this.subtotalAfterDiscount + this.deliveryCharges;
    if (!areEqual(this.totalAmount, calculatedTotal)) {
      console.error(
        `❌ Total amount mismatch: Expected ${calculatedTotal.toFixed(2)}, got ${this.totalAmount.toFixed(2)}`,
      );
      return next(
        new Error(
          `Total amount mismatch. Expected ${calculatedTotal.toFixed(2)}, got ${this.totalAmount.toFixed(2)}`,
        ),
      );
    }

    if (
      this.finalPayableAmount === undefined ||
      this.finalPayableAmount === null
    ) {
      this.finalPayableAmount = Math.max(
        0,
        this.totalAmount - (this.walletCreditUsed || 0),
      );
    }

    next();
  } catch (error) {
    console.error("❌ Pre-save validation error:", error);
    next(error);
  }
});

// ===== INDEXES =====
// ✅ FIX: was "OrderSchema" (wrong casing) — now all use "orderSchema"
// ✅ Removed duplicates, kept only the most useful compound + single-field indexes

// Compound indexes (cover the most common query patterns)
orderSchema.index({ customerInfo: 1, orderStatus: 1 }); // dashboard: user's active orders
orderSchema.index({ orderDate: 1, orderStatus: 1 }); // analytics date-range queries
orderSchema.index({ orderStatus: 1, createdAt: -1 }); // admin: filter by status, sorted
orderSchema.index({ orderType: 1, orderStatus: 1 }); // basket vs custom filter

// Single-field indexes
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ couponCode: 1 });
orderSchema.index({ createdAt: -1 }); // default sort for order lists

// orderId already has unique: true above — Mongoose creates the unique index automatically.
// razorpayPaymentId: sparse unique index to prevent duplicate payment processing
orderSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });

const Order = mongoose.model("Order", orderSchema);
export default Order;
