import mongoose from 'mongoose';

const WalletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: {
      values: ['active', 'blocked', 'suspended'],
      message: '{VALUE} is not a valid status'
    },
    default: 'active',
    required: true
  }
}, {
  timestamps: true
});

// Indexes
WalletSchema.index({ userId: 1 }, { unique: true });
WalletSchema.index({ status: 1 });

// Instance Methods
WalletSchema.methods.isActive = function() {
  return this.status === 'active';
};

WalletSchema.methods.block = async function() {
  this.status = 'blocked';
  return await this.save();
};

WalletSchema.methods.activate = async function() {
  this.status = 'active';
  return await this.save();
};

// Static Methods
WalletSchema.statics.findByUserId = async function(userId) {
  return await this.findOne({ userId });
};

WalletSchema.statics.createWallet = async function(userId) {
  const existingWallet = await this.findOne({ userId });
  if (existingWallet) {
    throw new Error('Wallet already exists for this user');
  }
  
  return await this.create({ userId });
};

// Pre-save hook
WalletSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'blocked') {
    console.log(`Wallet ${this._id} blocked at ${new Date()}`);
  }
  next();
});

export default mongoose.model('Wallet', WalletSchema);