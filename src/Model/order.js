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
          enum: ["1kg", "500g", "250g", "100g"],
          required: true,
          default: "1kg",
        },
        quantity: {
          type: Number,
          required: true,
          min: [1, "Quantity must be at least 1"],
          default: 1,
        },
        // Price per unit (based on weight)
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
      },
    ],

    orderDate: {
      type: Date,
      default: Date.now,
    },

    // Total of all vegetables
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

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    orderId: {
      type: String,
      required: true,
      unique: true,
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

    razorpayOrderId: {
      type: String,
      default: null,
    },

    razorpayPaymentId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Virtuals
orderSchema.virtual("totalItems").get(function () {
  return this.selectedVegetables.reduce((sum, item) => sum + item.quantity, 0);
});

orderSchema.virtual("uniqueVegetablesCount").get(function () {
  return this.selectedVegetables.length;
});

// Pre-save validation
orderSchema.pre("save", function (next) {
  // Validate vegetables total
  const calculatedVegTotal = this.selectedVegetables.reduce(
    (sum, item) => sum + item.subtotal,
    0
  );

  if (Math.abs(this.vegetablesTotal - calculatedVegTotal) > 0.01) {
    return next(
      new Error(
        `Vegetables total mismatch. Expected ${calculatedVegTotal}, got ${this.vegetablesTotal}`
      )
    );
  }

  // Calculate total differently based on order type
  let calculatedTotal;

  if (this.orderType === "basket") {
    // For basket: offerPrice (preset basket price) + delivery
    calculatedTotal = this.offerPrice + this.deliveryCharges;
  } else {
    // For custom: sum of vegetables + delivery
    calculatedTotal = this.vegetablesTotal + this.deliveryCharges;
  }

  if (Math.abs(this.totalAmount - calculatedTotal) > 0.01) {
    return next(
      new Error(
        `Total amount mismatch. Expected ${calculatedTotal}, got ${this.totalAmount}`
      )
    );
  }

  next();
});

// Indexes for better query performance
orderSchema.index({ customerInfo: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ orderType: 1 });

orderSchema.set("toJSON", { virtuals: true });
orderSchema.set("toObject", { virtuals: true });

const Order = mongoose.model("Order", orderSchema);
export default Order;
