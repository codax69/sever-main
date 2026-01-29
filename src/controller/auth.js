import User from "../Model/user.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";
import "dotenv/config";
import { OAuth2Client } from "google-auth-library";
import {
  sendPasswordResetEmail,
  sendEmailVerification,
  sendWelcomeEmail,
} from "../utility/emailService.js";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ============= ROLE CONFIGURATION =============

const ROLE_DOMAINS = new Map([
  ["user", process.env.USER_DOMAIN || "vegbazar.store"],
  ["admin", process.env.ADMIN_DOMAIN || "admin.vegbazar.store"],
]);

const VALID_ROLES = new Set(["user", "admin"]);

// ============= COOKIE CONFIGURATION =============

const isProduction = process.env.NODE_ENV === "production";

const getBaseCookieOptions = () => ({
  secure: isProduction,
  httpOnly: true,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
});

const getCookieOptions = (role, maxAge = 7 * 24 * 60 * 60 * 1000) => {
  const options = { ...getBaseCookieOptions(), maxAge };

  if (isProduction) {
    const domain = ROLE_DOMAINS.get(role) || ROLE_DOMAINS.get("user");
    options.domain = domain;
  }

  return options;
};

const baseCookieOptions = getBaseCookieOptions();

// ============= UTILITY FUNCTIONS =============

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { id: userId, role, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: role === "admin" ? "2h" : "2h" },
  );

  const refreshToken = jwt.sign(
    { id: userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: role === "admin" ? "1d" : "2h" },
  );

  return { accessToken, refreshToken };
};

const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ============= USER LOGIN (SIMPLE) =============
// ===============================
// Identifier Normalizer (DSA-safe)
// ===============================
const normalizeIdentifier = (value) => {
  if (!value || typeof value !== "string") {
    throw new ApiError(400, "Invalid email or phone");
  }

  const trimmed = value.trim();

  // Email detection (O(n))
  if (trimmed.includes("@")) {
    return {
      type: "email",
      value: trimmed.toLowerCase(),
    };
  }

  // Phone normalization (digits only)
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length < 10) {
    throw new ApiError(400, "Invalid email or phone");
  }

  return {
    type: "phone",
    value: digits,
  };
};

export const login = asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;

  if (!identifier || !password) {
    throw new ApiError(400, "Credentials required");
  }

  // 🔹 O(n) classify + normalize
  const { type, value } = normalizeIdentifier(identifier);

  // 🔹 Direct indexed query (O(log n))
  const user = await User.findOne({
    [type]: value, // email OR phone
    role: "user",
  }).select("+password isActive role username email phone picture");

  if (!user || !user.isActive) {
    throw new ApiError(401, "Invalid credentials");
  }

  // 🔹 Password check (bcrypt dominates cost anyway)
  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new ApiError(401, "Invalid credentials");
  }

  // 🔹 Token generation
  const { accessToken, refreshToken } = generateTokens(user._id, user.role);

  const hashedRefreshToken = hashToken(refreshToken);

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        isLoggedIn: true,
        refreshToken: hashedRefreshToken,
        lastLogin: new Date(),
      },
      $inc: { logCount: 1 },
    },
  );

  res
    .status(200)
    .cookie("accessToken", accessToken, getCookieOptions(user.role))
    .cookie("refreshToken", refreshToken, getCookieOptions(user.role))
    .json(
      new ApiResponse(
        200,
        {
          accessToken,
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            phone: user.phone,
            role: user.role,
            picture: user.picture,
          },
        },
        "Login successful",
      ),
    );
});

// ============= ADMIN LOGIN (WITH ALL SECURITY) =============

export const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError(400, "Email and password are required");
  }

  const user = await User.findOne({ email, role: "admin" }).select(
    "+password role isActive isEmailVerified _id username phone picture lastLogin logCount",
  );

  if (!user) {
    throw new ApiError(401, "Invalid admin credentials");
  }

  if (!user.isActive) {
    throw new ApiError(
      403,
      "Your admin account has been deactivated. Please contact support.",
    );
  }

  // Admin MUST verify email before login
  if (!user.isEmailVerified) {
    throw new ApiError(
      403,
      "Please verify your email before logging in. Check your inbox.",
    );
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new ApiError(401, "Invalid admin credentials");
  }

  const { accessToken, refreshToken } = generateTokens(user._id, user.role);
  const hashedRefreshToken = hashToken(refreshToken);

  const loggedInUser = await User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        isLoggedIn: true,
        refreshToken: hashedRefreshToken,
        lastLogin: new Date(),
      },
      $inc: { logCount: 1 },
    },
    { new: true, select: "-password -refreshToken" },
  );

  res
    .status(200)
    .cookie("accessToken", accessToken, getCookieOptions("admin"))
    .cookie("refreshToken", refreshToken, getCookieOptions("admin"))
    .json(
      new ApiResponse(
        200,
        {
          accessToken,
          user: {
            id: loggedInUser._id,
            username: loggedInUser.username,
            email: loggedInUser.email,
            phone: loggedInUser.phone,
            role: loggedInUser.role,
            picture: loggedInUser.picture,
            lastLogin: loggedInUser.lastLogin,
            logCount: loggedInUser.logCount,
          },
        },
        "Admin login successful",
      ),
    );
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  // console.log({token,password})
  if (!password) {
    throw new ApiError(400, "Password is required");
  }

  if (password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters");
  }

  const hashedToken = hashToken(token);

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  }).select("+password");

  if (!user) {
    throw new ApiError(400, "Invalid or expired reset token");
  }

  // Update password
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res.status(200).json(new ApiResponse(200, null, "Password reset successful"));
});
export const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.params;

  if (!token) {
    throw new ApiError(400, "Verification token is required");
  }

  const hashedToken = hashToken(token);

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: Date.now() },
    role: "admin", // Only admins need email verification
  });

  if (!user) {
    throw new ApiError(400, "Invalid or expired verification token");
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        null,
        "Email verified successfully. You can now login.",
      ),
    );
});

// ============= GOOGLE OAUTH (USER ONLY - NO VERIFICATION) =============

export const googleAuth = asyncHandler(async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    throw new ApiError(400, "Google credential is required");
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  const { sub: googleId, email, name, picture } = payload;

  if (!email) {
    throw new ApiError(400, "Email not provided by Google");
  }

  let user = await User.findOne({
    $or: [{ googleId }, { email }],
    role: "user", // Only for regular users
  });

  if (user) {
    if (!user.googleId) {
      user.googleId = googleId;
      user.picture = picture || user.picture;
      user.isEmailVerified = true;
      await user.save();
    }

    if (!user.isActive) {
      throw new ApiError(403, "Account is deactivated. Contact support.");
    }
  } else {
    // Create new user - auto-verified
    user = await User.create({
      username: name || email.split("@")[0],
      email,
      googleId,
      picture,
      role: "user",
      authProvider: "google",
      isActive: true,
      isApproved: true,
      isEmailVerified: true,
    });
  }

  const { accessToken, refreshToken } = generateTokens(user._id, user.role);
  const hashedRefreshToken = hashToken(refreshToken);

  const loggedInUser = await User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        isLoggedIn: true,
        refreshToken: hashedRefreshToken,
        lastLogin: new Date(),
      },
      $inc: { logCount: 1 },
    },
    { new: true, select: "-password -refreshToken" },
  );

  res
    .status(200)
    .cookie("accessToken", accessToken, getCookieOptions(user.role))
    .cookie("refreshToken", refreshToken, getCookieOptions(user.role))
    .json(
      new ApiResponse(
        200,
        {
          accessToken,
          user: {
            id: loggedInUser._id,
            username: loggedInUser.username,
            email: loggedInUser.email,
            role: loggedInUser.role,
            picture: loggedInUser.picture,
            authProvider: loggedInUser.authProvider,
          },
        },
        "Google login successful",
      ),
    );
});

// ============= PASSWORD RESET =============

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ApiError(400, "Email is required");
  }

  const user = await User.findOne({ email });

  // Always return success for security (don't reveal if email exists)
  if (!user) {
    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          null,
          "If an account exists with this email, you will receive a password reset link",
        ),
      );
    return;
  }

  // Generate reset token
  const resetToken = crypto.randomBytes(32).toString("hex");
  const hashedResetToken = hashToken(resetToken);

  // Save hashed token to database
  user.passwordResetToken = hashedResetToken;
  user.passwordResetExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  await user.save();

  // Create reset URL
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

  try {
    // Send email
    await sendPasswordResetEmail(user.email, user.username, resetUrl);

    res
      .status(200)
      .json(
        new ApiResponse(
          200,
          null,
          "If an account exists with this email, you will receive a password reset link",
        ),
      );
  } catch (error) {
    // If email fails, remove token from database
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    console.error("Failed to send password reset email:", error);
    throw new ApiError(
      500,
      "Failed to send password reset email. Please try again later.",
    );
  }
});

// UPDATE THE EXISTING adminRegister FUNCTION:
export const adminRegister = asyncHandler(async (req, res) => {
  const { username, email, password, phone,  } = req.body;

  // if (adminSecretKey !== process.env.ADMIN_SECRET_KEY) {
  //   throw new ApiError(403, "Invalid admin registration key");
  // }

  if (!username || !email || !password) {
    throw new ApiError(400, "Username, email, and password are required");
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new ApiError(400, "Invalid email format");
  }

  if (password.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters long");
  }

  const userExists = await User.findOne({ email }).lean().select("_id");
  if (userExists) {
    throw new ApiError(400, "User already exists with this email");
  }

  // Generate email verification token
  const emailVerificationToken = crypto.randomBytes(32).toString("hex");
  const hashedEmailToken = hashToken(emailVerificationToken);

  const admin = await User.create({
    username,
    email,
    password,
    phone,
    role: "admin",
    isActive: true,
    isApproved: true,
    emailVerificationToken: hashedEmailToken,
    emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000,
    isEmailVerified: false,
  });

  const verificationUrl = `${process.env.FRONTEND_URL}/admin/verify-email/${emailVerificationToken}`;

  try {
    // Send verification email
    await sendEmailVerification(admin.email, admin.username, verificationUrl);

    res.status(201).json(
      new ApiResponse(
        201,
        {
          user: {
            id: admin._id,
            username: admin.username,
            email: admin.email,
            role: admin.role,
          },
        },
        "Admin account created. Please check your email to verify your account.",
      ),
    );
  } catch (error) {
    console.error("Failed to send verification email:", error);
    // Still return success, but note email issue
    res.status(201).json(
      new ApiResponse(
        201,
        {
          user: {
            id: admin._id,
            username: admin.username,
            email: admin.email,
            role: admin.role,
          },
        },
        "Admin account created, but failed to send verification email. Please contact support.",
      ),
    );
  }
});

// UPDATE THE EXISTING resendVerificationEmail FUNCTION:
export const resendVerificationEmail = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ApiError(400, "Email is required");
  }

  const user = await User.findOne({ email, role: "admin" });

  if (!user) {
    throw new ApiError(404, "Admin account not found");
  }

  if (user.isEmailVerified) {
    throw new ApiError(400, "Email is already verified");
  }

  // Generate new verification token
  const emailVerificationToken = crypto.randomBytes(32).toString("hex");
  const hashedEmailToken = hashToken(emailVerificationToken);

  user.emailVerificationToken = hashedEmailToken;
  user.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000;
  await user.save();

  const verificationUrl = `${process.env.FRONTEND_URL}/admin/verify-email/${emailVerificationToken}`;

  try {
    await sendEmailVerification(user.email, user.username, verificationUrl);
    res
      .status(200)
      .json(new ApiResponse(200, null, "Verification email sent successfully"));
  } catch (error) {
    console.error("Failed to send verification email:", error);
    throw new ApiError(
      500,
      "Failed to send verification email. Please try again later.",
    );
  }
});

// OPTIONAL: Add welcome email to register function
export const register = asyncHandler(async (req, res) => {
  const { username, email, password, phone } = req.body;

  if (!username || !email || !password) {
    throw new ApiError(400, "Username, email, and password are required");
  }

  if (!EMAIL_REGEX.test(email)) {
    throw new ApiError(400, "Invalid email format");
  }

  if (password.length < 6) {
    throw new ApiError(400, "Password must be at least 6 characters long");
  }

  const userExists = await User.findOne({ email }).lean().select("_id");
  if (userExists) {
    throw new ApiError(400, "User already exists with this email");
  }

  const user = await User.create({
    username,
    email,
    password,
    phone,
    role: "user",
    isActive: true,
    isApproved: true,
    isEmailVerified: true,
  });

  const { accessToken, refreshToken } = generateTokens(user._id, user.role);
  const hashedRefreshToken = hashToken(refreshToken);

  await User.findByIdAndUpdate(user._id, {
    $set: {
      refreshToken: hashedRefreshToken,
      isLoggedIn: true,
    },
  });

  // Send welcome email (non-blocking)
  sendWelcomeEmail(user.email, user.username).catch((err) => {
    console.error("Failed to send welcome email:", err);
  });

  res
    .status(201)
    .cookie("accessToken", accessToken, getCookieOptions(user.role))
    .cookie("refreshToken", refreshToken, getCookieOptions(user.role))
    .json(
      new ApiResponse(
        201,
        {
          accessToken,
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            phone: user.phone,
            role: user.role,
          },
        },
        "Registration successful. Welcome to VegBazar!",
      ),
    );
});
// ============= TOKEN MANAGEMENT =============

export const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.cookies;

  if (!refreshToken) {
    throw new ApiError(401, "Refresh token not found");
  }

  const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

  if (decoded.type !== "refresh") {
    throw new ApiError(401, "Invalid token type");
  }

  const hashedRefreshToken = hashToken(refreshToken);
  const user = await User.findOne({
    _id: decoded.id,
    refreshToken: hashedRefreshToken,
    isLoggedIn: true,
  })
    .lean()
    .select("_id role isActive");

  if (!user) {
    throw new ApiError(401, "Invalid refresh token");
  }

  if (!user.isActive) {
    throw new ApiError(403, "Account is deactivated");
  }

  const { accessToken, refreshToken: newRefreshToken } = generateTokens(
    user._id,
    user.role,
  );
  const newHashedRefreshToken = hashToken(newRefreshToken);

  await User.findByIdAndUpdate(user._id, {
    $set: { refreshToken: newHashedRefreshToken },
  });

  res
    .status(200)
    .cookie("accessToken", accessToken, getCookieOptions(user.role))
    .cookie("refreshToken", newRefreshToken, getCookieOptions(user.role))
    .json(new ApiResponse(200, { accessToken }, "Token refreshed"));
});

// ============= LOGOUT =============

export const logout = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (userId) {
    await User.findByIdAndUpdate(userId, {
      $unset: { refreshToken: 1 },
      $set: { isLoggedIn: false },
    });
  }

  res
    .status(200)
    .clearCookie("accessToken", baseCookieOptions)
    .clearCookie("refreshToken", baseCookieOptions)
    .json(new ApiResponse(200, null, "Logout successful"));
});

// ============= USER PROFILE =============

export const getCurrentUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id)
    .lean()
    .select("-password -refreshToken");

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  res.status(200).json(new ApiResponse(200, user, "User fetched"));
});

export const updateProfile = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { username, phone, addresses } = req.body;

  const updateData = {};
  if (username) updateData.username = username;
  if (phone) updateData.phone = phone;
  if (addresses) updateData.addresses = addresses;

  if (Object.keys(updateData).length === 0) {
    throw new ApiError(400, "No fields to update");
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updateData },
    { new: true, runValidators: true, select: "-password -refreshToken" },
  );

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  res.status(200).json(new ApiResponse(200, user, "Profile updated"));
});

export const updateUserDetails = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { username, email, phone } = req.body;

  if (!username && !email && !phone) {
    throw new ApiError(400, "At least one field (username, email, or phone) is required");
  }

  const updateData = {};

  // Validate and add username
  if (username) {
    if (typeof username !== "string" || username.trim().length === 0) {
      throw new ApiError(400, "Username must be a non-empty string");
    }
    updateData.username = username.trim();
  }

  // Validate and add email
  if (email) {
    if (!EMAIL_REGEX.test(email)) {
      throw new ApiError(400, "Invalid email format");
    }

    // Check if email is already in use by another user
    const existingUser = await User.findOne({ 
      email: email.toLowerCase(), 
      _id: { $ne: userId } 
    }).lean().select("_id");

    if (existingUser) {
      throw new ApiError(400, "Email is already in use");
    }

    updateData.email = email.toLowerCase();
  }

  // Validate and add phone
  if (phone) {
    if (typeof phone !== "string") {
      throw new ApiError(400, "Phone must be a string");
    }
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      throw new ApiError(400, "Phone number must be at least 10 digits");
    }
    updateData.phone = phone.trim();
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updateData },
    { new: true, runValidators: true, select: "-password -refreshToken" },
  );

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  res.status(200).json(
    new ApiResponse(
      200,
      {
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role,
          picture: user.picture,
        },
      },
      "User details updated successfully",
    ),
  );
});

export const changePassword = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new ApiError(400, "Current and new password required");
  }

  const minLength = req.user.role === "admin" ? 8 : 6;
  if (newPassword.length < minLength) {
    throw new ApiError(
      400,
      `Password must be at least ${minLength} characters`,
    );
  }

  const user = await User.findById(userId).select("+password");

  if (!user || !user.password) {
    throw new ApiError(404, "User not found or no password set");
  }

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    throw new ApiError(401, "Current password is incorrect");
  }

  user.password = newPassword;
  await user.save();

  res.status(200).json(new ApiResponse(200, null, "Password changed"));
});

// ============= ADMIN FUNCTIONS =============

export const getAllUsers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search, role } = req.query;

  const filter = {};

  if (role && VALID_ROLES.has(role)) {
    filter.role = role;
  }

  if (search) {
    filter.$or = [
      { username: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const skip = (pageNum - 1) * limitNum;

  const [users, total] = await Promise.all([
    User.find(filter)
      .lean()
      .select("-password -refreshToken")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
    User.countDocuments(filter),
  ]);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        users,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      },
      "Users fetched",
    ),
  );
});

export const updateUserStatus = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") {
    throw new ApiError(400, "isActive must be boolean");
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { isActive } },
    { new: true, select: "-password -refreshToken" },
  );

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  // If deactivating, logout user
  if (!isActive) {
    await User.findByIdAndUpdate(userId, {
      $unset: { refreshToken: 1 },
      $set: { isLoggedIn: false },
    });
  }

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        user,
        `User ${isActive ? "activated" : "deactivated"}`,
      ),
    );
});

export const deleteUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const adminId = req.user?.id;

  if (userId === adminId) {
    throw new ApiError(400, "Cannot delete your own account");
  }

  const user = await User.findById(userId);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (user.role === "admin") {
    throw new ApiError(403, "Cannot delete admin accounts");
  }

  await User.findByIdAndDelete(userId);

  res.status(200).json(new ApiResponse(200, null, "User deleted"));
});
