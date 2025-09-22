import mongoose from "mongoose";

const offerSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  title: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String },
  vegetables: [
    { type: mongoose.Schema.Types.ObjectId, ref: "Vegetable" } // reference here
  ],
  vegetableLimit: {
    type: Number,
  },
});

const Offer = mongoose.model("Offer", offerSchema);

export default Offer;
