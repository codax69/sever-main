import mongoose from "mongoose";

const vegetableSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Vegetable name is required"],
      trim: true,
    },
    image: {
      type: String,
      required: [true, "Image URL is required"],
    },
    stockKg: {
      type: Number,
      default: 0,
      min: [0, "Stock cannot be negative"],
    },
    outOfStock: {
      type: Boolean,
      default: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    offer: {
      type: String,
      trim: true,
    },
    screenNumber: {
      type: Number,
      default: 1,
    },
    // Weight-based pricing (required but can be zeros for set-based items)
    prices: {
      weight1kg: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
      weight500g: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
      weight250g: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
      weight100g: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
    },
    marketPrices: {
      weight1kg: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
      weight500g: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
      weight250g: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
      weight100g: {
        type: Number,
        default: 0,
        min: [0, "Price cannot be negative"],
      },
    },
    // Set-based pricing (for bundles/pieces)
    setPricing: {
      enabled: {
        type: Boolean,
        default: false,
      },
      sets: [
        {
          quantity: {
            type: Number,
            min: [1, "Quantity must be at least 1"],
          },
          unit: {
            type: String,
            enum: ["pieces", "bundles", "sets", "nos"],
            default: "pieces",
          },
          price: {
            type: Number,
            min: [0, "Price cannot be negative"],
          },
          marketPrice: {
            type: Number,
            min: [0, "Market price cannot be negative"],
          },
          label: {
            type: String,
            trim: true,
          },
        },
      ],
    },
    // Stock tracking for piece-based items
    stockPieces: {
      type: Number,
      min: [0, "Stock pieces cannot be negative"],
      default: 0,
    },
  },
  { timestamps: true }
);

// Custom validation: ensure at least one pricing method has valid data
vegetableSchema.pre("validate", function (next) {
  if (this.setPricing?.enabled) {
    // Set pricing mode - require at least one set with valid data
    if (!this.setPricing.sets || this.setPricing.sets.length === 0) {
      return next(new Error("At least one set is required when set pricing is enabled"));
    }
    // Validate each set has required fields
    for (const set of this.setPricing.sets) {
      if (!set.quantity || !set.price || set.quantity <= 0 || set.price <= 0) {
        return next(new Error("Each set must have valid quantity and price"));
      }
    }
  } else {
    // Weight pricing mode - require valid prices
    if (!this.prices?.weight1kg || this.prices.weight1kg <= 0) {
      return next(new Error("Valid 1kg price is required for weight-based pricing"));
    }
    if (!this.marketPrices?.weight1kg || this.marketPrices.weight1kg <= 0) {
      return next(new Error("Valid 1kg market price is required for weight-based pricing"));
    }
  }
  next();
});

// Middleware to automatically set outOfStock based on stockKg or stockPieces
vegetableSchema.pre("save", function (next) {
  if (this.setPricing?.enabled) {
    // For set-based pricing, check stockPieces
    this.outOfStock = this.stockPieces === 0;
  } else {
    // For weight-based pricing, check stockKg
    this.outOfStock = this.stockKg < 0.25;
  }
  next();
});

// Handle findOneAndUpdate operations
vegetableSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate();
  
  if (!update.$set) {
    return next();
  }

  // Determine pricing mode after update
  let usingSetPricing = false;
  if (update.$set.setPricing?.enabled !== undefined) {
    usingSetPricing = update.$set.setPricing.enabled;
  } else {
    const docToUpdate = await this.model.findOne(this.getQuery());
    if (docToUpdate) {
      usingSetPricing = docToUpdate.setPricing?.enabled === true;
    }
  }

  // Set outOfStock based on pricing mode
  if (usingSetPricing) {
    if (update.$set.stockPieces !== undefined) {
      update.$set.outOfStock = update.$set.stockPieces === 0;
    }
  } else {
    if (update.$set.stockKg !== undefined) {
      update.$set.outOfStock = update.$set.stockKg < 0.25;
    }
  }

  next();
});

// Virtual for default price (1kg weight-based)
vegetableSchema.virtual("price").get(function () {
  return this.prices?.weight1kg || 0;
});

vegetableSchema.virtual("marketPrice").get(function () {
  return this.marketPrices?.weight1kg || 0;
});

const Vegetable = mongoose.model("Vegetable", vegetableSchema);
export default Vegetable;