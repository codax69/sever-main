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
      required: [true, "Stock quantity is required"],
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
    prices: {
      weight1kg: {
        type: Number,
        required: [true, "1kg price is required"],
        min: [1, "Price must be greater than 0"],
      },
      weight500g: {
        type: Number,
        required: [true, "500g price is required"],
        min: [1, "Price must be greater than 0"],
      },
      weight250g: {
        type: Number,
        required: [true, "250g price is required"],
        min: [1, "Price must be greater than 0"],
      },
      weight100g: {
        type: Number,
        required: [true, "100g price is required"],
        min: [1, "Price must be greater than 0"],
      },
    },
    marketPrices: {
      weight1kg: {
        type: Number,
        required: [true, "1kg market price is required"],
        min: [1, "Price must be greater than 0"],
      },
      weight500g: {
        type: Number,
        required: [true, "500g market price is required"],
        min: [1, "Price must be greater than 0"],
      },
      weight250g: {
        type: Number,
        required: [true, "250g market price is required"],
        min: [1, "Price must be greater than 0"],
      },
      weight100g: {
        type: Number,
        required: [true, "100g market price is required"],
        min: [1, "Price must be greater than 0"],
      },
    },
  },
  { timestamps: true }
);

// Middleware to automatically set outOfStock based on stockKg
vegetableSchema.pre("save", function (next) {
  this.outOfStock = this.stockKg === 0;
  next();
});

vegetableSchema.virtual("price").get(function () {
  return this.prices.weight1kg;
});

vegetableSchema.virtual("marketPrice").get(function () {
  return this.marketPrices.weight1kg;
});
// In your Vegetable model file (e.g., vegetable.js)

vegetableSchema.pre('save', function(next) {
  // Automatically set outOfStock based on stockKg
  if (this.stockKg < 0.25) {
    this.outOfStock = true;
  } else {
    this.outOfStock = false;
  }
  next();
});

// Also handle findOneAndUpdate operations
vegetableSchema.pre('findOneAndUpdate', async function(next) {
  const update = this.getUpdate();
  
  // Check if stockKg is being updated
  if (update.$inc && update.$inc.stockKg !== undefined) {
    const docToUpdate = await this.model.findOne(this.getQuery());
    const newStockKg = docToUpdate.stockKg + update.$inc.stockKg;
    
    if (newStockKg < 0.25) {
      update.$set = update.$set || {};
      update.$set.outOfStock = true;
    } else {
      update.$set = update.$set || {};
      update.$set.outOfStock = false;
    }
  }
  
  next();
});

const Vegetable = mongoose.model("Vegetable", vegetableSchema);
export default Vegetable;