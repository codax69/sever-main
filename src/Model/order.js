import mongoose from "mongoose";

const orderSchema = new mongoose.Schema({
  customerInfo: { type: Object, required: true }, // Can be replaced with a reference to Customer model
  selectedOffer: { type: Object, required: true }, // Can be replaced with a reference to Offer model
  selectedVegetables: [{ type: Object, required: true }], // Can be replaced with references to Vegetable model
  orderDate: { type: Date, required: true },
  totalAmount: { type: Number, required: true },
  orderId: { type: String, required: true, unique: true }
});

const Order = mongoose.model("Order", orderSchema);

export default Order;
