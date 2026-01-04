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
      ref: "Customer",
      required: true,
    },

    // For basket orders - reference to predefined offer/basket
    selectedOffer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Offer",
      required: function () {
        return this.orderType === "basket";
      },
    },

    // For both types - vegetables details
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
              // Allow weight formats: 1kg, 500g, 250g, 100g, etc.
              // Allow set formats: set0, set1, set2, etc.
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
        // Price per unit (based on weight or set)
        pricePerUnit: {
          type: Number,
          required: true,
          min: [0, "Price must be greater than or equal to 0"],
        },
        // Total for this item (pricePerUnit * quantity)
        subtotal: {
          type: Number,
          required: true,
          min: [0, "Subtotal must be greater than or equal to 0"],
        },
        // Optional: flag to indicate if this came from a basket
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

    // Total of all vegetables (before coupon discount)
    vegetablesTotal: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    // Basket/Offer price (only for basket orders)
    offerPrice: {
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

    // Subtotal after applying coupon discount
    subtotalAfterDiscount: {
      type: Number,
      required: true,
      min: [0, "Subtotal after discount cannot be negative"],
    },

    // Discount applied (if basket has special pricing)
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

    // Final total: subtotalAfterDiscount + deliveryCharges
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    orderId: {
      type: String,
      required: true,
      unique: true, // ✅ This creates index automatically
      trim: true,
    },

    paymentMethod: {
      type: String,
      enum: ["COD", "ONLINE"],
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

    stockUpdates: {
      type: Array,
      default: [],
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
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
  // Validate vegetables total
  const calculatedVegTotal = this.selectedVegetables.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  if (this.orderType === "custom") {
    if (Math.abs(this.vegetablesTotal - calculatedVegTotal) > 0.01) {
      return next(
        new Error(
          `Vegetables total mismatch. Expected ${calculatedVegTotal}, got ${this.vegetablesTotal}`
        )
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
    expectedSubtotal = this.offerPrice - this.couponDiscount;
  } else {
    expectedSubtotal = this.vegetablesTotal - this.couponDiscount;
  }

  if (Math.abs(this.subtotalAfterDiscount - expectedSubtotal) > 0.01) {
    return next(
      new Error(
        `Subtotal after discount mismatch. Expected ${expectedSubtotal}, got ${this.subtotalAfterDiscount}`
      )
    );
  }

  // Validate total amount: subtotalAfterDiscount + deliveryCharges
  const calculatedTotal = this.subtotalAfterDiscount + this.deliveryCharges;

  if (Math.abs(this.totalAmount - calculatedTotal) > 0.01) {
    return next(
      new Error(
        `Total amount mismatch. Expected ${calculatedTotal}, got ${this.totalAmount}`
      )
    );
  }

  next();
});

// ===== INDEXES =====
// Compound indexes for common queries
orderSchema.index({ customerInfo: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ orderType: 1, orderStatus: 1 });

// Single field indexes
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ couponCode: 1 });
orderSchema.index({ orderDate: 1 });
orderSchema.index({ createdAt: -1 });

// Note: orderId already has unique: true, which creates an index automatically
// REMOVED: orderSchema.index({ orderId: 1 }); - This would be a duplicate

const Order = mongoose.model("Order", orderSchema);
export default Order;
