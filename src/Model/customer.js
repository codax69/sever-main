import mongoose from "mongoose";

const customerSchema = new mongoose.Schema({
  name: { type: String,
     required: true },
  email: { type: String,
     required: true, unique: true },
  mobile: { type: String,
     required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
});

const Customer = mongoose.model("Customer", customerSchema);

export default Customer;
