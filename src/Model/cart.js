import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vegetable",
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    max: 99,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  weight: {
    type: String,
    required: true,
    enum: ["1kg", "500g", "250g", "100g"],
  },
  selectedWeight: {
    type: Number, // in grams
    required: true,
  },
  totalPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // One cart per user
      index: true,
    },
    items: [cartItemSchema],
    subtotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    tax: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveryCharges: {
      type: Number,
      default: 0,
      min: 0,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    total: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      default: "INR",
    },
    status: {
      type: String,
      enum: ["active", "checked_out", "abandoned"],
      default: "active",
    },
    appliedCoupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Coupon",
    },
    couponDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },
    deliveryAddress: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
    },
    estimatedDeliveryTime: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
    // Performance tracking
    itemCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    // Analytics
    totalValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    averageItemPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
cartSchema.index({ user: 1, status: 1 });
cartSchema.index({ status: 1, updatedAt: -1 });
cartSchema.index({ total: -1 });
cartSchema.index({ "items.product": 1 });

// Pre-save middleware to calculate totals
cartSchema.pre("save", function (next) {
  this.calculateTotals();
  this.itemCount = this.items.length;
  this.lastActivity = new Date();

  if (this.items.length > 0) {
    this.totalValue = this.items.reduce((sum, item) => sum + item.totalPrice, 0);
    this.averageItemPrice = this.totalValue / this.items.length;
  }

  next();
});

// Instance methods
cartSchema.methods.calculateTotals = function () {
  this.subtotal = this.items.reduce((sum, item) => sum + item.totalPrice, 0);
  this.total = this.subtotal + this.tax + this.deliveryCharges - this.discount - this.couponDiscount;

  // Ensure total is not negative
  this.total = Math.max(0, this.total);

  return this.total;
};

cartSchema.methods.addItem = function (productId, quantity, price, weight, selectedWeight) {
  const existingItemIndex = this.items.findIndex(
    item => item.product.toString() === productId.toString() &&
           item.weight === weight
  );

  if (existingItemIndex > -1) {
    // Update existing item
    this.items[existingItemIndex].quantity += quantity;
    this.items[existingItemIndex].totalPrice = this.items[existingItemIndex].quantity * price;
    this.items[existingItemIndex].updatedAt = new Date();
  } else {
    // Add new item
    this.items.push({
      product: productId,
      quantity,
      price,
      weight,
      selectedWeight,
      totalPrice: quantity * price,
      addedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return this.save();
};

cartSchema.methods.updateItemQuantity = function (productId, weight, newQuantity) {
  const itemIndex = this.items.findIndex(
    item => item.product.toString() === productId.toString() &&
           item.weight === weight
  );

  if (itemIndex > -1) {
    if (newQuantity <= 0) {
      this.items.splice(itemIndex, 1);
    } else {
      this.items[itemIndex].quantity = newQuantity;
      this.items[itemIndex].totalPrice = newQuantity * this.items[itemIndex].price;
      this.items[itemIndex].updatedAt = new Date();
    }
    return this.save();
  }

  throw new Error("Item not found in cart");
};

cartSchema.methods.removeItem = function (productId, weight) {
  const itemIndex = this.items.findIndex(
    item => item.product.toString() === productId.toString() &&
           item.weight === weight
  );

  if (itemIndex > -1) {
    this.items.splice(itemIndex, 1);
    return this.save();
  }

  throw new Error("Item not found in cart");
};

cartSchema.methods.clearCart = function () {
  this.items = [];
  this.appliedCoupon = null;
  this.couponDiscount = 0;
  this.deliveryAddress = null;
  return this.save();
};

cartSchema.methods.applyCoupon = function (couponId, discountAmount) {
  this.appliedCoupon = couponId;
  this.couponDiscount = discountAmount;
  return this.save();
};

cartSchema.methods.removeCoupon = function () {
  this.appliedCoupon = null;
  this.couponDiscount = 0;
  return this.save();
};

// Static methods
cartSchema.statics.getOrCreateCart = async function (userId) {
  let cart = await this.findOne({ user: userId, status: "active" });
  if (!cart) {
    cart = new this({ user: userId });
    await cart.save();
  }
  return cart;
};

cartSchema.statics.getCartStats = async function () {
  const stats = await this.aggregate([
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
        totalValue: { $sum: "$total" },
        avgItems: { $avg: "$itemCount" },
      },
    },
  ]);

  return stats.reduce((acc, stat) => {
    acc[stat._id] = {
      count: stat.count,
      totalValue: stat.totalValue,
      avgItems: stat.avgItems,
    };
    return acc;
  }, {});
};

const Cart = mongoose.model("Cart", cartSchema);

export default Cart;