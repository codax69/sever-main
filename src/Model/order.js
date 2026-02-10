import mongoose from "mongoose";

const orderSchema = new mongoose.Schema(
  {
    // Order Type identifier
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

    // ✅ FIX 1: Make deliveryAddressId optional
    deliveryAddressId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      required: false,  // ✅ Changed from true
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
        // Fields for set-based pricing
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

    // ===== COUPON FIELDS =====
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

    // ===== WALLET CREDIT FIELDS =====
    walletCreditUsed: {
      type: Number,
      min: 0,
      default: 0,
    },

    // ✅ FIX 2: Make finalPayableAmount required with proper default
    finalPayableAmount: {
      type: Number,
      required: true,  // ✅ Make it required
      min: 0,
      default: function() {
        return this.totalAmount || 0;  // ✅ Default to totalAmount
      },
    },

    // ===== CASHBACK FIELDS =====
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
      default: null,  // ✅ Add default
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

    // ✅ FIX 3: Define stockUpdates properly (or remove if not needed)
    stockUpdates: {
      type: [mongoose.Schema.Types.Mixed],  // ✅ Better type definition
      default: [],
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

// ✅ FIX 4: Improved pre-save validation with better error handling
orderSchema.pre("save", function (next) {
  try {
    // Helper function for floating-point comparison
    const areEqual = (a, b, tolerance = 0.02) => Math.abs(a - b) <= tolerance;

    // Validate vegetables total
    const calculatedVegTotal = this.selectedVegetables.reduce(
      (sum, item) => sum + (item.subtotal || 0),
      0,
    );

    if (this.orderType === "custom") {
      if (!areEqual(this.vegetablesTotal, calculatedVegTotal)) {
        console.error(`❌ Vegetables total mismatch: Expected ${calculatedVegTotal.toFixed(2)}, got ${this.vegetablesTotal.toFixed(2)}`);
        return next(
          new Error(
            `Vegetables total mismatch. Expected ${calculatedVegTotal.toFixed(2)}, got ${this.vegetablesTotal.toFixed(2)}`,
          ),
        );
      }
    }

    // Validate coupon discount
    if (this.couponDiscount < 0) {
      return next(new Error("Coupon discount cannot be negative"));
    }

    // Validate subtotalAfterDiscount calculation
    let expectedSubtotal;
    if (this.orderType === "basket") {
      expectedSubtotal = Math.max(0, this.basketPrice - this.couponDiscount);
    } else {
      expectedSubtotal = Math.max(0, this.vegetablesTotal - this.couponDiscount);
    }

    if (!areEqual(this.subtotalAfterDiscount, expectedSubtotal)) {
      console.error(`❌ Subtotal mismatch: Expected ${expectedSubtotal.toFixed(2)}, got ${this.subtotalAfterDiscount.toFixed(2)}`);
      return next(
        new Error(
          `Subtotal after discount mismatch. Expected ${expectedSubtotal.toFixed(2)}, got ${this.subtotalAfterDiscount.toFixed(2)}`,
        ),
      );
    }

    // Validate total amount: subtotalAfterDiscount + deliveryCharges
    const calculatedTotal = this.subtotalAfterDiscount + this.deliveryCharges;

    if (!areEqual(this.totalAmount, calculatedTotal)) {
      console.error(`❌ Total amount mismatch: Expected ${calculatedTotal.toFixed(2)}, got ${this.totalAmount.toFixed(2)}`);
      return next(
        new Error(
          `Total amount mismatch. Expected ${calculatedTotal.toFixed(2)}, got ${this.totalAmount.toFixed(2)}`,
        ),
      );
    }

    // ✅ NEW: Validate finalPayableAmount
    if (this.finalPayableAmount === undefined || this.finalPayableAmount === null) {
      this.finalPayableAmount = Math.max(0, this.totalAmount - (this.walletCreditUsed || 0));
    }

    next();
  } catch (error) {
    console.error("❌ Pre-save validation error:", error);
    next(error);
  }
});

// ===== INDEXES =====
orderSchema.index({ customerInfo: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ orderType: 1, orderStatus: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ couponCode: 1 });
orderSchema.index({ orderDate: 1 });
orderSchema.index({ createdAt: -1 });

const Order = mongoose.model("Order", orderSchema);
export default Order;