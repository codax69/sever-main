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
    // Address (for users)
    addresses: [{
      type: {
        type: String,
        enum: ["home", "work", "other"],
        default: "home",
      },
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String,
      isDefault: {
        type: Boolean,
        default: false,
      },
    }],
  },
  {
    timestamps: true,
  }
);

// Index for geospatial queries (delivery partners)
userSchema.index({ "roleDetails.currentLocation": "2dsphere" });

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

const User = mongoose.model("User", userSchema);

export default User;