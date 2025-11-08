import mongoose from "mongoose";
import { type } from "os";

const offerSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  title: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String },
  vegetables: [
    { type: mongoose.Schema.Types.ObjectId, ref: "Vegetable" }, // reference here
  ],
  vegetableLimit: {
    type: Number,
  },
  weight: {
    type: String,
    enum: ["1kg", "500g", "250g", "100g"],
  },
  totalWeight: {
    type: Number,
    required: true,
  },
  clickCount: {
    type: Number,
    default: 0,
  },
});

const Offer = mongoose.model("Offer", offerSchema);

export default Offer;
