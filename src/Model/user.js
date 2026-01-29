import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      select: false,
    },
    phone: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ["user", "admin", "editor", "delivery_partner", "packaging"],
      default: "user",
      required: true,
    },
    // Role-specific fields
    roleDetails: {
      // For delivery partners
      vehicleType: {
        type: String,
        enum: ["bike", "car", "van", "truck"],
      },
      vehicleNumber: String,
      licenseNumber: String,
      isAvailable: {
        type: Boolean,
        default: false,
      },
      currentLocation: {
        type: {
          type: String,
          enum: ["Point"],
          default: "Point",
        },
        coordinates: {
          type: [Number], // [longitude, latitude]
          default: [0, 0],
        },
      },
      deliveryZones: [String],

      // For packaging staff
      warehouseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Warehouse",
      },
      shift: {
        type: String,
        enum: ["morning", "afternoon", "evening", "night"],
      },
      packagingStation: String,

      // For editors
      department: {
        type: String,
        enum: ["content", "product", "inventory", "orders"],
      },
      permissions: [String],
    },
    // Google OAuth fields
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    picture: {
      type: String,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    // Account status
    isActive: {
      type: Boolean,
      default: true,
    },
    isApproved: {
      type: Boolean,
      default: false, // For delivery partners and packaging staff
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    approvedAt: Date,
    rejectionReason: String,
    // Session management
    refreshToken: {
      type: String,
      select: false,
    },
    accessToken: {
      type: String,
      select: false,
    },
    isLoggedIn: {
      type: Boolean,
      default: false,
    },
    lastLogin: Date,
    logCount: {
      type: Number,
      default: 0,
    },
    // Performance metrics (for delivery partners and packaging)
    performanceMetrics: {
      totalDeliveries: {
        type: Number,
        default: 0,
      },
      successfulDeliveries: {
        type: Number,
        default: 0,
      },
      totalPackages: {
        type: Number,
        default: 0,
      },
      rating: {
        type: Number,
        default: 0,
        min: 0,
        max: 5,
      },
      totalRatings: {
        type: Number,
        default: 0,
      },
    },

    // ========== REFACTORED: Address references instead of embedded data ==========
    addresses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Address",
      },
    ],

    // Default address reference for quick access
    defaultAddress: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Address",
    },

    // Orders reference
    orders: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    // Password reset token fields
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Index for geospatial queries (delivery partners)
userSchema.index({ "roleDetails.currentLocation": "2dsphere" });

userSchema.index({ phone: 1 });
userSchema.index({ role: 1, isActive: 1 });

// Virtual to populate addresses
userSchema.virtual("addressDetails", {
  ref: "Address",
  localField: "addresses",
  foreignField: "_id",
});

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  if (this.password) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  next();
});

// Auto-approve regular users
userSchema.pre("save", function (next) {
  if (this.isNew && this.role === "user") {
    this.isApproved = true;
  }
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) {
    return false;
  }
  return await bcrypt.compare(candidatePassword, this.password);
};

// Check if user has password set
userSchema.methods.hasPassword = function () {
  return !!this.password;
};

// Check if user has specific permission
userSchema.methods.hasPermission = function (permission) {
  if (this.role === "admin") return true; // Admin has all permissions
  if (this.role === "editor" && this.roleDetails?.permissions) {
    return this.roleDetails.permissions.includes(permission);
  }
  return false;
};

// Get role display name
userSchema.methods.getRoleDisplayName = function () {
  const roleNames = {
    user: "Customer",
    admin: "Administrator",
    editor: "Editor",
    delivery_partner: "Delivery Partner",
    packaging: "Packaging Staff",
  };
  return roleNames[this.role] || this.role;
};

// ========== NEW METHODS FOR ADDRESS MANAGEMENT ==========

/**
 * Add a new address to the user
 * @param {Object} addressData - Address data
 * @returns {Promise<Address>} The created address
 */
userSchema.methods.addAddress = async function (addressData) {
  const Address = mongoose.model("Address");

  const address = new Address({
    ...addressData,
    user: this._id,
  });

  await address.save();

  // Add to user's addresses array
  this.addresses.push(address._id);

  // Set as default if it's the first address or explicitly marked
  if (this.addresses.length === 1 || addressData.isDefault) {
    await this.setDefaultAddress(address._id);
  }

  await this.save();
  return address;
};

/**
 * Remove an address from the user
 * @param {String} addressId - Address ID to remove
 * @returns {Promise<Boolean>} Success status
 */
userSchema.methods.removeAddress = async function (addressId) {
  const Address = mongoose.model("Address");

  // Remove from addresses array
  this.addresses = this.addresses.filter(
    (id) => id.toString() !== addressId.toString(),
  );

  // If this was the default address, set a new one
  if (
    this.defaultAddress &&
    this.defaultAddress.toString() === addressId.toString()
  ) {
    this.defaultAddress = this.addresses.length > 0 ? this.addresses[0] : null;
  }

  await this.save();

  // Delete the address document
  await Address.findByIdAndDelete(addressId);

  return true;
};

/**
 * Set an address as default
 * @param {String} addressId - Address ID to set as default
 * @returns {Promise<User>} Updated user
 */
userSchema.methods.setDefaultAddress = async function (addressId) {
  const Address = mongoose.model("Address");

  // Verify the address belongs to this user
  const address = await Address.findOne({ _id: addressId, user: this._id });
  if (!address) {
    throw new Error("Address not found or does not belong to user");
  }

  // Update previous default address
  if (this.defaultAddress) {
    await Address.findByIdAndUpdate(this.defaultAddress, { isDefault: false });
  }

  // Set new default
  this.defaultAddress = addressId;
  await address.updateOne({ isDefault: true });
  await this.save();

  return this;
};

/**
 * Get all user addresses
 * @param {Boolean} activeOnly - Return only active addresses
 * @returns {Promise<Address[]>} User addresses
 */
userSchema.methods.getAddresses = async function (activeOnly = false) {
  const Address = mongoose.model("Address");

  const query = { user: this._id };
  if (activeOnly) {
    query.isActive = true;
  }

  return await Address.find(query).sort({ isDefault: -1, createdAt: -1 });
};

/**
 * Get user's default address
 * @returns {Promise<Address|null>} Default address
 */
userSchema.methods.getDefaultAddress = async function () {
  if (!this.defaultAddress) return null;

  const Address = mongoose.model("Address");
  return await Address.findById(this.defaultAddress);
};

const User = mongoose.model("User", userSchema);

export default User;
