import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["home", "work", "other"],
      default: "home",
    },
    street: {
      type: String,
      required: true,
      trim: true,
    },
    area: {
      type: String,
      trim: true,
      required: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    state: {
      type: String,
      required: true,
      trim: true,
    },
    pincode: {
      type: String,
      required: true,
      trim: true,
    },
    country: {
      type: String,
      required: true,
      trim: true,
      default: "India",
    },
    // Geospatial coordinates for distance calculations
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0],
        validate: {
          validator: function (coords) {
            return coords.length === 2 &&
                   coords[0] >= -180 && coords[0] <= 180 && // longitude
                   coords[1] >= -90 && coords[1] <= 90;     // latitude
          },
          message: "Invalid coordinates format"
        }
      },
    },
    // Distance from delivery center (in kilometers)
    distance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Delivery charges based on distance (in paisa, like 2000 = ₹20)
    deliveryCharges: {
      type: Number,
      default: 2000, // Default ₹20
      min: 0,
    },
    // Base delivery charge (fixed component)
    baseDeliveryCharge: {
      type: Number,
      default: 2000, // ₹20
      min: 0,
    },
    // Per km charge for distance-based pricing
    perKmCharge: {
      type: Number,
      default: 500, // ₹5 per km
      min: 0,
    },
    // Free delivery threshold distance (in km)
    freeDeliveryThreshold: {
      type: Number,
      default: 5, // 5km free delivery
      min: 0,
    },
    // Minimum delivery charge
    minDeliveryCharge: {
      type: Number,
      default: 1000, // ₹10 minimum
      min: 0,
    },
    // Maximum delivery charge
    maxDeliveryCharge: {
      type: Number,
      default: 10000, // ₹100 maximum
      min: 0,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Delivery zone information
    deliveryZone: {
      type: String,
      trim: true,
    },
    // Estimated delivery time in minutes
    estimatedDeliveryTime: {
      type: Number,
      default: 45, // 45 minutes
      min: 15,
    },
    // Last distance calculation timestamp
    lastDistanceUpdate: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
addressSchema.index({ user: 1, isDefault: -1 }); // For finding user's default address
addressSchema.index({ user: 1, isActive: -1 }); // For finding active addresses
addressSchema.index({ location: "2dsphere" }); // For geospatial queries
addressSchema.index({ city: 1, state: 1 }); // For location-based queries
addressSchema.index({ createdAt: -1 }); // For recent addresses

// Pre-save middleware to calculate delivery charges based on distance
addressSchema.pre("save", function (next) {
  if (this.isModified("distance") || this.isNew) {
    this.calculateDeliveryCharges();
    this.lastDistanceUpdate = new Date();
  }
  next();
});

// Instance method to calculate delivery charges
addressSchema.methods.calculateDeliveryCharges = function () {
  // If within free delivery threshold, use base charge only
  if (this.distance <= this.freeDeliveryThreshold) {
    this.deliveryCharges = this.baseDeliveryCharge;
  } else {
    // Calculate distance-based charge
    const distanceCharge = (this.distance - this.freeDeliveryThreshold) * this.perKmCharge;
    this.deliveryCharges = this.baseDeliveryCharge + distanceCharge;
  }

  // Apply min/max constraints
  this.deliveryCharges = Math.max(this.minDeliveryCharge, this.deliveryCharges);
  this.deliveryCharges = Math.min(this.maxDeliveryCharge, this.deliveryCharges);

  return this.deliveryCharges;
};

// Instance method to update distance and recalculate charges
addressSchema.methods.updateDistance = function (newDistance, deliveryCenterCoords = null) {
  this.distance = newDistance;

  // Update location if coordinates provided
  if (deliveryCenterCoords && Array.isArray(deliveryCenterCoords)) {
    this.location.coordinates = deliveryCenterCoords;
  }

  this.calculateDeliveryCharges();
  this.lastDistanceUpdate = new Date();

  return this.save();
};

// Static method to find addresses within distance
addressSchema.statics.findNearbyAddresses = function (centerCoords, maxDistance = 50) {
  return this.find({
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: centerCoords,
        },
        $maxDistance: maxDistance * 1000, // Convert km to meters
      },
    },
    isActive: true,
  });
};

// Static method to get delivery charges for an address
addressSchema.statics.getDeliveryCharges = async function (addressId) {
  const address = await this.findById(addressId);
  if (!address) {
    throw new Error("Address not found");
  }

  // Recalculate if distance is old (more than 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (address.lastDistanceUpdate < oneDayAgo) {
    // Here you could trigger a distance recalculation
    // For now, just return current charges
  }

  return {
    baseCharge: address.baseDeliveryCharge,
    distanceCharge: address.deliveryCharges - address.baseDeliveryCharge,
    totalCharge: address.deliveryCharges,
    distance: address.distance,
    currency: "INR",
    lastUpdated: address.lastDistanceUpdate,
  };
};

// Virtual for formatted delivery charge
addressSchema.virtual("formattedDeliveryCharge").get(function () {
  return `₹${(this.deliveryCharges / 100).toFixed(2)}`;
});

// Virtual for full address string
addressSchema.virtual("fullAddress").get(function () {
  const areaPart = this.area ? `${this.area}, ` : "";
  return `${this.street}, ${areaPart}${this.city}, ${this.state} ${this.pincode}, ${this.country}`;
});

const Address = mongoose.model("Address", addressSchema);

export default Address;