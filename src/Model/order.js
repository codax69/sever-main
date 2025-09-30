import mongoose from "mongoose";

const orderSchema = new mongoose.Schema({
  customerInfo: { type: Object, required: true }, // Can be replaced with a reference to Customer model
  selectedOffer: { type: Object, required: true }, // Can be replaced with a reference to Offer model
  selectedVegetables: [{ type: Object, required: true }], // Can be replaced with references to Vegetable model
  orderDate: { type: Date, required: true },
  totalAmount: { type: Number, required: true },
  orderId: { type: String, required: true, unique: true },
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
  razorpayPaymentId: {
    type: String,
  },
  razorpayOrderId: {
    type: String,
  },
});

const Order = mongoose.model("Order", orderSchema);

export default Order;
