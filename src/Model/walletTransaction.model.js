import mongoose from "mongoose";

const walletTransactionSchema = new mongoose.Schema(
  {
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: [true, "Wallet ID is required"],
      index: true,
    },
    type: {
      type: String,
      enum: {
        values: ["credit", "debit"],
        message: "{VALUE} is not a valid transaction type",
      },
      required: [true, "Transaction type is required"],
    },
    source: {
      type: String,
      enum: {
        values: [
          "refund",
          "promo",
          "order_payment",
          "reversal",
          "adjustment",
          "cashback",
        ],
        message: "{VALUE} is not a valid transaction source",
      },
      required: [true, "Transaction source is required"],
    },
    referenceId: {
      type: String,
      required: [true, "Reference ID is required"],
      index: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [1, "Amount must be at least 1 paise"],
      validate: {
        validator: function (value) {
          return Number.isInteger(value);
        },
        message: "Amount must be in paise (integer only)",
      },
    },
    openingBalance: {
      type: Number,
      required: [true, "Opening balance is required"],
      min: [0, "Opening balance cannot be negative"],
    },
    closingBalance: {
      type: Number,
      required: [true, "Closing balance is required"],
      min: [0, "Closing balance cannot be negative"],
    },
    status: {
      type: String,
      enum: {
        values: ["success", "reversed", "pending"],
        message: "{VALUE} is not a valid transaction status",
      },
      default: "success",
    },
    description: {
      type: String,
      maxlength: [200, "Description cannot exceed 200 characters"],
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
walletTransactionSchema.index({ referenceId: 1, source: 1 }, { unique: true });
walletTransactionSchema.index({ walletId: 1, createdAt: -1 });
walletTransactionSchema.index({ type: 1, status: 1 });
walletTransactionSchema.index({ createdAt: -1 });

// Virtual for amount in rupees
walletTransactionSchema.virtual("amountInRupees").get(function () {
  return this.amount / 100;
});

walletTransactionSchema.virtual("openingBalanceInRupees").get(function () {
  return this.openingBalance / 100;
});

walletTransactionSchema.virtual("closingBalanceInRupees").get(function () {
  return this.closingBalance / 100;
});

// Instance Methods
walletTransactionSchema.methods.reverse = async function (session) {
  if (this.status === "reversed") {
    throw new Error("Transaction already reversed");
  }

  if (this.type !== "debit") {
    throw new Error("Only debit transactions can be reversed");
  }

  this.status = "reversed";
  await this.save({ session });

  // Get current balance before creating reversal transaction
  const currentBalance = await this.constructor.getCurrentBalance(
    this.walletId,
    session,
  );

  // Create reversal credit transaction
  const reversalTxn = await this.constructor.create(
    [
      {
        walletId: this.walletId,
        type: "credit",
        source: "reversal",
        referenceId: `REV_${this.referenceId}`,
        amount: this.amount,
        openingBalance: currentBalance,
        closingBalance: currentBalance + this.amount,
        description: `Reversal of ${this.referenceId}`,
        metadata: {
          originalTransactionId: this._id,
        },
      },
    ],
    { session },
  );

  return reversalTxn[0];
};

// Static Methods
walletTransactionSchema.statics.getCurrentBalance = async function (
  walletId,
  session = null,
) {
  const lastTxn = await this.findOne({ walletId })
    .sort({ createdAt: -1 })
    .session(session)
    .lean();

  return lastTxn ? lastTxn.closingBalance : 0;
};

walletTransactionSchema.statics.getTransactionHistory = async function (
  walletId,
  { page = 1, limit = 20, type = null, source = null } = {},
) {
  const query = { walletId };

  if (type) query.type = type;
  if (source) query.source = source;

  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    this.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    this.countDocuments(query),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

walletTransactionSchema.statics.createCreditTransaction = async function (
  walletId,
  source,
  referenceId,
  amount,
  description = "",
  session,
) {
  const currentBalance = await this.getCurrentBalance(walletId, session);

  return await this.create(
    [
      {
        walletId,
        type: "credit",
        source,
        referenceId,
        amount,
        openingBalance: currentBalance,
        closingBalance: currentBalance + amount,
        description,
        status: "success",
      },
    ],
    { session },
  );
};

walletTransactionSchema.statics.createDebitTransaction = async function (
  walletId,
  source,
  referenceId,
  amount,
  description = "",
  session,
) {
  const currentBalance = await this.getCurrentBalance(walletId, session);

  if (currentBalance < amount) {
    throw new Error("Insufficient wallet balance");
  }

  return await this.create(
    [
      {
        walletId,
        type: "debit",
        source,
        referenceId,
        amount,
        openingBalance: currentBalance,
        closingBalance: currentBalance - amount,
        description,
        status: "success",
      },
    ],
    { session },
  );
};

// Pre-save validation
walletTransactionSchema.pre("save", function (next) {
  // Validate balance calculation
  if (this.type === "credit") {
    const expectedClosing = this.openingBalance + this.amount;
    if (this.closingBalance !== expectedClosing) {
      return next(new Error("Invalid balance calculation for credit"));
    }
  } else if (this.type === "debit") {
    const expectedClosing = this.openingBalance - this.amount;
    if (this.closingBalance !== expectedClosing) {
      return next(new Error("Invalid balance calculation for debit"));
    }
  }

  next();
});

// Enable virtuals in JSON
walletTransactionSchema.set("toJSON", { virtuals: true });
walletTransactionSchema.set("toObject", { virtuals: true });

export default mongoose.model("walletTransaction", walletTransactionSchema);
