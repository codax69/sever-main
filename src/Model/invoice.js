import mongoose from "mongoose";

const invoiceSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true, // ✅ This creates index automatically
    },

    invoiceNumber: {
      type: String,
      required: true,
      unique: true, // ✅ This creates index automatically
    },

    customerInfo: {
      name: { type: String, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
    },

    deliveryAddress: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
      required: false,
    },

    items: [
      {
        vegetable: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Vegetable",
        },
        vegetableName: { type: String, required: true },
        weight: { type: String },
        quantity: { type: Number, required: true },
        pricePerUnit: { type: Number, required: true },
        subtotal: { type: Number, required: true },
        setLabel: { type: String },
        unit: { type: String },
      },
    ],

    pricing: {
      subtotal: { type: Number, required: true, min: 0 },
      couponDiscount: { type: Number, default: 0, min: 0 },
      deliveryCharges: { type: Number, required: true, min: 0 },
      totalAmount: { type: Number, required: true, min: 0 },
      currency: { type: String, default: "INR" },
    },

    payment: {
      method: {
        type: String,
        enum: ["COD", "ONLINE"],
        required: true,
      },
      status: {
        type: String,
        enum: ["pending", "completed", "failed"],
        default: "pending",
      },
      razorpayOrderId: { type: String },
      razorpayPaymentId: { type: String },
    },

    status: {
      type: String,
      enum: ["generated", "sent", "paid", "cancelled"],
      default: "generated",
    },

    pdfPath: { type: String },
    emailSent: { type: Boolean, default: false },
    emailSentAt: { type: Date },
    emailMessageId: { type: String },

    notes: { type: String },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// ===== VIRTUALS =====
invoiceSchema.virtual("formattedInvoiceNumber").get(function () {
  return `INV-${this.invoiceNumber}`;
});

invoiceSchema.virtual("totalSavings").get(function () {
  return this.pricing.couponDiscount;
});

// ===== PRE-SAVE MIDDLEWARE - IMPROVED WITH RETRY LOGIC =====
invoiceSchema.pre("save", async function (next) {
  if (this.isNew && !this.invoiceNumber) {
    try {
      // Generate invoice number: YYYYMMDD + sequential number
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

      // Find the last invoice number for today with better query
      const lastInvoice = await this.constructor
        .findOne({
          invoiceNumber: new RegExp(`^${dateStr}`),
        })
        .sort({ invoiceNumber: -1 })
        .select("invoiceNumber")
        .lean();

      let sequence = 1;
      if (lastInvoice && lastInvoice.invoiceNumber) {
        const lastSequence = parseInt(lastInvoice.invoiceNumber.slice(-4));
        if (!isNaN(lastSequence)) {
          sequence = lastSequence + 1;
        }
      }

      // Generate with retry logic for race conditions
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        const candidateNumber = `${dateStr}${sequence.toString().padStart(4, "0")}`;

        // Check if this number already exists
        const exists = await this.constructor.exists({
          invoiceNumber: candidateNumber,
        });

        if (!exists) {
          this.invoiceNumber = candidateNumber;
          break;
        }

        // If exists, increment and try again
        sequence++;
        attempts++;
      }

      if (!this.invoiceNumber) {
        throw new Error(
          "Failed to generate unique invoice number after multiple attempts",
        );
      }
    } catch (error) {
      console.error("Invoice number generation error:", error);
      return next(error);
    }
  }
  next();
});

// ===== METHODS =====
invoiceSchema.methods.calculateTotals = function () {
  this.pricing.subtotal = this.items.reduce(
    (sum, item) => sum + item.subtotal,
    0,
  );
  this.pricing.totalAmount =
    this.pricing.subtotal -
    this.pricing.couponDiscount +
    this.pricing.deliveryCharges;
  return this.pricing.totalAmount;
};

// ===== STATIC METHODS =====
invoiceSchema.statics.findByOrderId = function (orderId) {
  return this.findOne({ orderId });
};

invoiceSchema.statics.findByInvoiceNumber = function (invoiceNumber) {
  return this.findOne({ invoiceNumber });
};

invoiceSchema.statics.findByCustomerEmail = function (email) {
  return this.find({ "customerInfo.email": email });
};

// Generate unique invoice number - more reliable method
invoiceSchema.statics.generateInvoiceNumber = async function () {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");

  // Use MongoDB aggregation to find the max sequence for today
  const result = await this.aggregate([
    {
      $match: {
        invoiceNumber: new RegExp(`^${dateStr}`),
      },
    },
    {
      $project: {
        sequence: {
          $toInt: { $substr: ["$invoiceNumber", 8, 4] },
        },
      },
    },
    {
      $group: {
        _id: null,
        maxSequence: { $max: "$sequence" },
      },
    },
  ]);

  const nextSequence =
    result.length > 0 && result[0].maxSequence ? result[0].maxSequence + 1 : 1;

  return `${dateStr}${nextSequence.toString().padStart(4, "0")}`;
};

// ===== INDEXES =====
// Note: orderId and invoiceNumber already have unique: true which creates indexes
// REMOVED: invoiceSchema.index({ orderId: 1 }); - This would be a duplicate
// REMOVED: invoiceSchema.index({ invoiceNumber: 1 }); - This would be a duplicate

// Additional indexes for common queries
invoiceSchema.index({ "customerInfo.email": 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ createdAt: -1 });
invoiceSchema.index({ "payment.status": 1 });
invoiceSchema.index({ emailSent: 1 });

// Compound index for admin queries
invoiceSchema.index({ status: 1, createdAt: -1 });

const Invoice = mongoose.model("Invoice", invoiceSchema);
export default Invoice;
