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
      min: [1, "Stock must be at least 1 kg"],
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

vegetableSchema.virtual("price").get(function () {
  return this.prices.weight1kg;
});

vegetableSchema.virtual("marketPrice").get(function () {
  return this.marketPrices.weight1kg;
});

const Vegetable = mongoose.model("Vegetable", vegetableSchema);
export default Vegetable;
