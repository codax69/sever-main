import User from "../Model/user.js";
import Order from "../Model/order.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";
import "dotenv/config";
import { OAuth2Client } from "google-auth-library";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ============= OPTIMIZED DATA STRUCTURES =============

// Use Map for O(1) lookup instead of object
const ROLE_DOMAINS = new Map([
  ["user", process.env.USER_DOMAIN || "vegbazar.store"],
  ["admin", process.env.ADMIN_DOMAIN || "admin.vegbazar.store"],
  ["editor", process.env.ADMIN_DOMAIN || "admin.vegbazar.store"],
  ["delivery_partner", process.env.DELIVERY_DOMAIN || "delivery.vegbazar.store"],
  ["packaging", process.env.PACKAGING_DOMAIN || "warehouse.vegbazar.store"],
]);

// Set for O(1) membership check
const ROLES_REQUIRING_APPROVAL = new Set(["delivery_partner", "packaging", "editor"]);
const VALID_ROLES = new Set(["user", "admin", "editor", "delivery_partner", "packaging"]);

// Validation rules as Map for efficient lookup
const ROLE_VALIDATION_RULES = new Map([
  ["delivery_partner", {
    required: ["vehicleType"],
    validValues: { vehicleType: new Set(["bike", "car", "van", "truck"]) }
  }],
  ["packaging", {
    required: ["shift"],
    validValues: { shift: new Set(["morning", "afternoon", "evening", "night"]) }
  }],
  ["editor", {
    required: ["department"],
    validValues: { department: new Set(["content", "product", "inventory", "orders"]) }
  }]
]);

// ============= UTILITY FUNCTIONS =============

// Optimized cookie options with caching
const cookieOptionsCache = new Map();

const getCookieOptions = (role, maxAge = null) => {
  const cacheKey = `${role}-${maxAge}`;
  
  if (cookieOptionsCache.has(cacheKey)) {
    return cookieOptionsCache.get(cacheKey);
  }

  const domain = ROLE_DOMAINS.get(role) || ROLE_DOMAINS.get("user");
  const isProduction = process.env.NODE_ENV === "production";
  
  const options = {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
    domain,
  };

  if (maxAge) options.maxAge = maxAge;

  cookieOptionsCache.set(cacheKey, options);
  return options;
};

const baseCookieOptions = {
  secure: process.env.NODE_ENV === "production",
  httpOnly: true,
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
};

// Optimized token generation - parallel signing
const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { id: userId, role, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  const refreshToken = jwt.sign(
    { id: userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );

  return { accessToken, refreshToken };
};

// Use Buffer for faster hashing
const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

// Optimized validation with early returns
const validateRoleRequirements = (role, roleDetails) => {
  const rules = ROLE_VALIDATION_RULES.get(role);
  if (!rules) return [];

  const errors = [];

  // Check required fields
  for (const field of rules.required) {
    if (!roleDetails?.[field]) {
      errors.push(`${field} is required for ${role}`);
      continue; // Skip validation if field is missing
    }

    // Check valid values
    if (rules.validValues[field] && !rules.validValues[field].has(roleDetails[field])) {
      errors.push(`Invalid ${field} for ${role}`);
    }
  }

  return errors;
};

// Email validation using regex (compiled once)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ============= REGISTRATION =============

export const register = async (req, res) => {
  try {
    const { username, email, password, phone, role, roleDetails } = req.body;

    // Early validation with single return
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Username, email, and password are required"
      });
    }

    // Use compiled regex
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format"
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long"
      });
    }

    const userRole = role || "user";

    // O(1) Set lookup
    if (!VALID_ROLES.has(userRole)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role specified"
      });
    }

    // Validate role requirements only if needed
    if (userRole !== "user" && userRole !== "admin") {
      const validationErrors = validateRoleRequirements(userRole, roleDetails);
      if (validationErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: validationErrors.join(", ")
        });
      }
    }

    // Check existence using lean() for faster query
    const userExists = await User.findOne({ email }).lean().select("_id");
    if (userExists) {
      return res.status(400).json({
        success: false,
        message: "User already exists with this email"
      });
    }

    // Auto-approve users that don't require approval
    const requiresApproval = ROLES_REQUIRING_APPROVAL.has(userRole);

    // Create user with all fields at once
    const user = await User.create({
      username,
      email,
      password,
      phone,
      role: userRole,
      roleDetails: roleDetails || {},
      isApproved: !requiresApproval, // Auto-approve if not requiring approval
    });

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user._id, user.role);
    const hashedRefreshToken = hashToken(refreshToken);
    const hashAccessToken = hashToken(accessToken);

    // Single update operation
    await User.findByIdAndUpdate(user._id, {
      $set: {
        refreshToken: hashedRefreshToken,
        accessToken: hashAccessToken,
        isLoggedIn: true,
      }
    }, { new: false }); // Don't return document (faster)

    // Conditional message
    const message = requiresApproval
      ? `${user.getRoleDisplayName()} registration submitted for approval`
      : "User registered successfully";

    res
      .status(201)
      .cookie("accessToken", accessToken, getCookieOptions(user.role, 7200000))
      .cookie("refreshToken", refreshToken, getCookieOptions(user.role, 604800000))
      .json({
        success: true,
        message,
        accessToken,
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role,
          roleDisplayName: user.getRoleDisplayName(),
          isApproved: user.isApproved,
          needsApproval: requiresApproval,
          roleDetails: user.roleDetails,
        },
      });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      message: "Registration failed",
      error: error.message
    });
  }
};

// ============= LOGIN =============

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
     
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    // Single query with only needed fields
    const user = await User.findOne({ email })
      .select("+password role isActive isApproved _id username phone roleDetails picture lastLogin logCount");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Early checks
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact support."
      });
    }

    // O(1) Set lookup for approval check
    if (ROLES_REQUIRING_APPROVAL.has(user.role) && !user.isApproved) {
      return res.status(403).json({
        success: false,
        message: "Your account is pending approval. Please wait for admin approval.",
        needsApproval: true
      });
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user._id, user.role);
    const hashedRefreshToken = hashToken(refreshToken);
    const hashAccessToken = hashToken(accessToken);

    // Update with atomic operations
    const loggedInUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          isLoggedIn: true,
          refreshToken: hashedRefreshToken,
          accessToken: hashAccessToken,
          lastLogin: new Date()
        },
        $inc: { logCount: 1 }
      },
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    res
      .status(200)
      .cookie("accessToken", accessToken, getCookieOptions(user.role, 7200000))
      .cookie("refreshToken", refreshToken, getCookieOptions(user.role, 604800000))
      .json({
        success: true,
        message: "Login successful",
        accessToken,
        user: {
          id: loggedInUser._id,
          username: loggedInUser.username,
          email: loggedInUser.email,
          phone: loggedInUser.phone,
          role: loggedInUser.role,
          roleDisplayName: loggedInUser.getRoleDisplayName(),
          isApproved: loggedInUser.isApproved,
          isActive: loggedInUser.isActive,
          lastLogin: loggedInUser.lastLogin,
          logCount: loggedInUser.logCount,
          roleDetails: loggedInUser.roleDetails,
          picture: loggedInUser.picture,
        },
      });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Login failed",
      error: error.message
    });
  }
};

// ============= ADMIN LOGIN (SEPARATE) =============

export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    // Query only for admin role
    const user = await User.findOne({ email, role: "admin" })
      .select("+password role isActive isApproved _id username phone roleDetails picture lastLogin logCount");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid admin credentials"
      });
    }

    // Check if admin account is active
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your admin account has been deactivated. Please contact support."
      });
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid admin credentials"
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user._id, user.role);
    const hashedRefreshToken = hashToken(refreshToken);
    const hashAccessToken = hashToken(accessToken);

    // Update with atomic operations
    const loggedInUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          isLoggedIn: true,
          refreshToken: hashedRefreshToken,
          accessToken: hashAccessToken,
          lastLogin: new Date()
        },
        $inc: { logCount: 1 }
      },
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    res
      .status(200)
      .cookie("accessToken", accessToken, getCookieOptions("admin", 7200000))
      .cookie("refreshToken", refreshToken, getCookieOptions("admin", 604800000))
      .json({
        success: true,
        message: "Admin login successful",
        accessToken,
        user: {
          id: loggedInUser._id,
          username: loggedInUser.username,
          email: loggedInUser.email,
          phone: loggedInUser.phone,
          role: loggedInUser.role,
          roleDisplayName: loggedInUser.getRoleDisplayName(),
          isApproved: loggedInUser.isApproved,
          isActive: loggedInUser.isActive,
          lastLogin: loggedInUser.lastLogin,
          logCount: loggedInUser.logCount,
          roleDetails: loggedInUser.roleDetails,
          picture: loggedInUser.picture,
        },
      });
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({
      success: false,
      message: "Admin login failed",
      error: error.message
    });
  }
};

// ============= GOOGLE OAUTH =============

export const googleAuth = async (req, res) => {
  try {
    const { credential, role } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Google credential is required"
      });
    }

    // Verify Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email not provided by Google"
      });
    }

    // Optimized query with lean()
    let user = await User.findOne({
      $or: [{ googleId }, { email }]
    }).select("+password");

    if (user) {
      // Update existing user if needed
      if (!user.googleId) {
        await User.findByIdAndUpdate(user._id, {
          $set: {
            googleId,
            picture: picture || user.picture,
            isEmailVerified: true
          }
        });
        user.googleId = googleId;
        user.picture = picture || user.picture;
      }

      // Status checks
      if (!user.isActive) {
        return res.status(403).json({
          success: false,
          message: "Your account has been deactivated. Please contact support."
        });
      }

      if (ROLES_REQUIRING_APPROVAL.has(user.role) && !user.isApproved) {
        return res.status(403).json({
          success: false,
          message: "Your account is pending approval",
          needsApproval: true
        });
      }
    } else {
      // Only allow user and editor roles via Google
      const userRole = role && ["user", "editor"].includes(role) ? role : "user";
      const requiresApproval = ROLES_REQUIRING_APPROVAL.has(userRole);

      user = await User.create({
        username: name || email.split('@')[0],
        email,
        googleId,
        picture,
        role: userRole,
        isEmailVerified: true,
        authProvider: "google",
        isApproved: !requiresApproval, // Auto-approve if not requiring approval
      });
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user._id, user.role);
    const hashedRefreshToken = hashToken(refreshToken);
    const hashAccessToken = hashToken(accessToken);

    // Single atomic update
    const loggedInUser = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          isLoggedIn: true,
          refreshToken: hashedRefreshToken,
          accessToken: hashAccessToken,
          lastLogin: new Date()
        },
        $inc: { logCount: 1 }
      },
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    res
      .status(200)
      .cookie("accessToken", accessToken, getCookieOptions(user.role, 7200000))
      .cookie("refreshToken", refreshToken, getCookieOptions(user.role, 604800000))
      .json({
        success: true,
        message: "Google login successful",
        accessToken,
        user: {
          id: loggedInUser._id,
          username: loggedInUser.username,
          email: loggedInUser.email,
          role: loggedInUser.role,
          roleDisplayName: loggedInUser.getRoleDisplayName(),
          picture: loggedInUser.picture,
          authProvider: loggedInUser.authProvider,
          isApproved: loggedInUser.isApproved,
          lastLogin: loggedInUser.lastLogin,
          roleDetails: loggedInUser.roleDetails,
        },
      });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({
      success: false,
      message: "Google authentication failed",
      error: error.message
    });
  }
};

// ============= LINK GOOGLE ACCOUNT =============

export const linkGoogleAccount = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { credential } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Google credential is required"
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, picture } = payload;

    // Check if already linked (lean for speed)
    const existingUser = await User.findOne({ googleId }).lean().select("_id");
    if (existingUser && existingUser._id.toString() !== userId) {
      return res.status(400).json({
        success: false,
        message: "This Google account is already linked to another user"
      });
    }

    // Update user
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          googleId,
          ...(picture && { picture }),
          isEmailVerified: true
        }
      },
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    res.status(200).json({
      success: true,
      message: "Google account linked successfully",
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        picture: user.picture,
        googleId: user.googleId,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error("Link Google account error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to link Google account",
      error: error.message
    });
  }
};

// ============= UNLINK GOOGLE ACCOUNT =============

export const unlinkGoogleAccount = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated"
      });
    }

    const user = await User.findById(userId).select("+password authProvider");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Prevent lockout
    if (!user.password && user.authProvider === "google") {
      return res.status(400).json({
        success: false,
        message: "Cannot unlink Google account. Please set a password first to avoid losing access to your account."
      });
    }

    // Unlink
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $unset: { googleId: 1 },
        $set: { authProvider: "local" }
      },
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    res.status(200).json({
      success: true,
      message: "Google account unlinked successfully",
      user: {
        id: updatedUser._id,
        username: updatedUser.username,
        email: updatedUser.email,
        authProvider: updatedUser.authProvider
      }
    });
  } catch (error) {
    console.error("Unlink Google account error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to unlink Google account",
      error: error.message
    });
  }
};

// ============= REFRESH TOKEN =============

export const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.cookies;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: "Refresh token not found"
      });
    }

    // Verify token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    if (decoded.type !== "refresh") {
      return res.status(401).json({
        success: false,
        message: "Invalid token type"
      });
    }

    // Find user efficiently
    const hashedRefreshToken = hashToken(refreshToken);
    const user = await User.findOne({
      _id: decoded.id,
      refreshToken: hashedRefreshToken,
      isLoggedIn: true
    }).lean().select("_id role isActive");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token"
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account is deactivated"
      });
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(
      user._id,
      user.role
    );
    const newHashedRefreshToken = hashToken(newRefreshToken);
    const newHashedAccessToken = hashToken(accessToken);

    // Update tokens
    await User.findByIdAndUpdate(user._id, {
      $set: {
        refreshToken: newHashedRefreshToken,
        accessToken: newHashedAccessToken,
      }
    });

    res
      .status(200)
      .cookie("accessToken", accessToken, getCookieOptions(user.role, 7200000))
      .cookie("refreshToken", newRefreshToken, getCookieOptions(user.role, 604800000))
      .json({
        success: true,
        message: "Tokens refreshed successfully",
        accessToken,
      });
  } catch (error) {
    console.error("Token refresh error:", error);
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired refresh token"
      });
    }
    res.status(500).json({
      success: false,
      message: "Token refresh failed",
      error: error.message
    });
  }
};

// ============= LOGOUT =============

export const logout = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (userId) {
      await User.findByIdAndUpdate(userId, {
        $unset: { refreshToken: 1, accessToken: 1 },
        $set: { isLoggedIn: false }
      });
    }

    res
      .status(200)
      .clearCookie("accessToken", baseCookieOptions)
      .clearCookie("refreshToken", baseCookieOptions)
      .json({
        success: true,
        message: "Logout successful",
      });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      success: false,
      message: "Logout failed",
      error: error.message
    });
  }
};

// ============= LOGOUT ALL DEVICES =============

export const logoutAllDevices = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (userId) {
      await User.findByIdAndUpdate(userId, {
        $unset: { refreshToken: 1, accessToken: 1 },
        $set: { isLoggedIn: false }
      });
    }

    res
      .status(200)
      .clearCookie("accessToken", baseCookieOptions)
      .clearCookie("refreshToken", baseCookieOptions)
      .json({
        success: true,
        message: "Logged out from all devices successfully",
      });
  } catch (error) {
    console.error("Logout all devices error:", error);
    res.status(500).json({
      success: false,
      message: "Logout from all devices failed",
      error: error.message
    });
  }
};

// ============= GET CURRENT USER =============

export const getCurrentUser = asyncHandler(async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id)
      .lean()
      .select("-password -refreshToken -accessToken");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    return res.status(200).json(
      new ApiResponse(200, user, "User fetched successfully")
    );
  } catch (error) {
    next(error);
  }
});

// ============= APPROVE USER (ADMIN ONLY) =============

export const approveUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const adminId = req.user?.id;
    const { approved, rejectionReason } = req.body;

    if (req.user?.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can approve users"
      });
    }

    const user = await User.findById(userId).lean().select("role isApproved");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // O(1) check
    if (!ROLES_REQUIRING_APPROVAL.has(user.role)) {
      return res.status(400).json({
        success: false,
        message: "This user role does not require approval"
      });
    }

    // Update approval status
    const updateData = {
      isApproved: approved,
      approvedBy: adminId,
      approvedAt: new Date(),
    };

    if (!approved && rejectionReason) {
      updateData.rejectionReason = rejectionReason;
    } else {
      updateData.$unset = { rejectionReason: 1 };
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    res.status(200).json({
      success: true,
      message: approved ? "User approved successfully" : "User rejected",
      user: {
        id: updatedUser._id,
        username: updatedUser.username,
        email: updatedUser.email,
        role: updatedUser.role,
        roleDisplayName: updatedUser.getRoleDisplayName(),
        isApproved: updatedUser.isApproved,
        approvedAt: updatedUser.approvedAt,
        rejectionReason: updatedUser.rejectionReason,
      }
    });
  } catch (error) {
    console.error("Approve user error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to approve user",
      error: error.message
    });
  }
};

// ============= UPDATE AVAILABILITY (DELIVERY PARTNER) =============

export const updateAvailability = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { isAvailable, currentLocation } = req.body;

    if (req.user?.role !== "delivery_partner") {
      return res.status(403).json({
        success: false,
        message: "Only delivery partners can update availability"
      });
    }

    const updateData = {};

    if (typeof isAvailable === "boolean") {
      updateData["roleDetails.isAvailable"] = isAvailable;
    }

    if (currentLocation?.coordinates) {
      if (!Array.isArray(currentLocation.coordinates) || currentLocation.coordinates.length !== 2) {
        return res.status(400).json({
          success: false,
          message: "Invalid coordinates format. Expected [longitude, latitude]"
        });
      }

      updateData["roleDetails.currentLocation"] = {
        type: "Point",
        coordinates: currentLocation.coordinates
      };
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, select: "roleDetails" }
    );

    res.status(200).json({
      success: true,
      message: "Availability updated successfully",
      user: {
        id: user._id,
        isAvailable: user.roleDetails?.isAvailable,
        currentLocation: user.roleDetails?.currentLocation,
      }
    });
  } catch (error) {
    console.error("Update availability error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update availability",
      error: error.message
    });
  }
};

// ============= GET ALL USERS BY ROLE (ADMIN) =============

export const getUsersByRole = async (req, res) => {
  try {
    const { role } = req.params;
    const { approved, active, page = 1, limit = 20 } = req.query;

    // Build filter efficiently
    const filter = { role };
    if (approved !== undefined) filter.isApproved = approved === 'true';
    if (active !== undefined) filter.isActive = active === 'true';

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Parallel queries for better performance
    const [users, total] = await Promise.all([
      User.find(filter)
        .lean()
        .select("-password -refreshToken -accessToken")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      User.countDocuments(filter)
    ]);

    res.json({
      success: true,
      count: users.length,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      users
    });
  } catch (error) {
    console.error("Get users by role error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message
    });
  }
};

// ============= UPDATE USER STATUS (ADMIN) =============

export const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isActive must be a boolean value"
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { isActive } },
      { new: true, select: "-password -refreshToken -accessToken" }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      user
    });
  } catch (error) {
    console.error("Update user status error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update user status",
      error: error.message
    });
  }
};

// ============= UPDATE PROFILE =============

export const updateProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { username, phone, addresses } = req.body;

    // Build update object efficiently
    const updateData = {};
    if (username) updateData.username = username;
    if (phone) updateData.phone = phone;
    if (addresses) updateData.addresses = addresses;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update"
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true, select: "-password -refreshToken -accessToken" }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.json({
      success: true,
      message: "Profile updated successfully",
      user
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile",
      error: error.message
    });
  }
};

// ============= CHANGE PASSWORD =============

export const changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required"
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long"
      });
    }

    const user = await User.findById(userId).select("+password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: "No password set for this account. Please set a password first."
      });
    }

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Current password is incorrect"
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: "Password changed successfully"
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to change password",
      error: error.message
    });
  }
};

// ============= SET PASSWORD (FOR GOOGLE USERS) =============

export const setPassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required"
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long"
      });
    }

    const user = await User.findById(userId).select("+password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    if (user.password) {
      return res.status(400).json({
        success: false,
        message: "Password already set. Use change password instead."
      });
    }

    // Set password
    user.password = password;
    user.authProvider = "local";
    await user.save();

    res.json({
      success: true,
      message: "Password set successfully"
    });
  } catch (error) {
    console.error("Set password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to set password",
      error: error.message
    });
  }
};