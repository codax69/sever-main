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
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [1, "Price must be greater than 0"],
    },
    screenNumber: {
      type: Number,
      enum: [1, 2, 3, 4, 5], // categories
      default: 1,
    },
  },
  { timestamps: true }
);

const Vegetable = mongoose.model("Vegetable", vegetableSchema);

export default Vegetable;
