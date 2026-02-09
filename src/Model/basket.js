import mongoose from "mongoose";

const basketSchema = new mongoose.Schema(
  {
    id: { type: Number, required: true, unique: true },
    title: { type: String, required: true },
    price: { type: Number, required: true },
    description: { type: String },
    vegetables: [
      {
        vegetable: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Vegetable",
          required: true,
        },
        weight: {
          type: String,
          required: true,
        },
        quantity: {
          type: Number,
          default: 1,
          min: 1,
        },
      },
    ],
    vegetableLimit: {
      type: Number,
    },
    weight: {
      type: String,
    },
    totalWeight: {
      type: Number,
      required: true,
    },
    clickCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

const Basket = mongoose.model("Basket", basketSchema);

export default Basket;
