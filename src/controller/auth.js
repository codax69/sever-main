import User from "../Model/user.js";
import jwt from "jsonwebtoken";
import crypto, { verify } from "crypto";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import "dotenv/config"
import { Domain } from "domain";

const cookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: "none",
  Domain:"admin.vegbazar.cloud"
};

const accessTokenOptions = {
  ...cookieOptions,
  maxAge: 15 * 60 * 1000, // 15 minutes
};

const refreshTokenOptions = {
  ...cookieOptions,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Generate tokens
const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { id: userId, role, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );

  const refreshToken = jwt.sign(
    { id: userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );

  return { accessToken, refreshToken };
};

// Hash refresh token for storage
const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

export const register = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Username, email, and password are required" 
      });
    }

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ 
        success: false,
        message: "User already exists" 
      });
    }

    const user = await User.create({
      username,
      email,
      password,
      role: role || "user", // Default role
    });

    const { accessToken, refreshToken } = generateTokens(user._id, user.role);
    const hashedRefreshToken = hashToken(refreshToken);

    // Store hashed refresh token in database
    await User.findByIdAndUpdate(user._id, {
      refreshToken: hashedRefreshToken,
      isLoggedIn: true,
    });

    res
      .status(201)
      .cookie("accessToken", accessToken, accessTokenOptions)
      .cookie("refreshToken", refreshToken, refreshTokenOptions)
      .json({
        success: true,
        message: "User registered successfully",
        accessToken,
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          role: user.role,
        },
      });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ 
      success: false,
      message: "Registration failed" 
    });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Email and password are required" 
      });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: "Invalid credentials" 
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ 
        success: false,
        message: "Invalid credentials" 
      });
    }

    const { accessToken, refreshToken } = generateTokens(user._id, user.role);
    const hashedRefreshToken = hashToken(refreshToken);
    const hashAccessToken = hashToken(accessToken);

    // Update user with new refresh token and login status
    const loggedInUser = await User.findByIdAndUpdate(
      user._id,
      { 
        $set: { 
          isLoggedIn: true,
          refreshToken: hashedRefreshToken,
          accessToken:hashAccessToken,
          lastLogin: new Date()
        }, 
        $inc: { logCount: 1 } 
      },
      { new: true }
    ).select("-password -refreshToken");

    res
      .status(200)
      .cookie("accessToken", accessToken, accessTokenOptions)
      .cookie("refreshToken", refreshToken, refreshTokenOptions)
      .json({
        success: true,
        message: "Login successful",
        accessToken,
        user: {
          id: loggedInUser._id,
          username: loggedInUser.username,
          email: loggedInUser.email,
          role: loggedInUser.role,
          lastLogin: loggedInUser.lastLogin,
        },
      });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ 
      success: false,
      message: "Login failed" 
    });
  }
};

export const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.cookies;

    if (!refreshToken) {
      return res.status(401).json({ 
        success: false,
        message: "Refresh token not found" 
      });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    
    if (decoded.type !== "refresh") {
      return res.status(401).json({ 
        success: false,
        message: "Invalid token type" 
      });
    }

    const hashedRefreshToken = hashToken(refreshToken);
    const user = await User.findOne({ 
      _id: decoded.id, 
      refreshToken: hashedRefreshToken,
      isLoggedIn: true 
    });

    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: "Invalid refresh token" 
      });
    }

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(
      user._id, 
      user.role
    );
    const newHashedRefreshToken = hashToken(newRefreshToken);

    // Update refresh token in database
    await User.findByIdAndUpdate(user._id, {
      refreshToken: newHashedRefreshToken,
    });

    res
      .status(200)
      .cookie("accessToken", accessToken, accessTokenOptions)
      .cookie("refreshToken", newRefreshToken, refreshTokenOptions)
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
      message: "Token refresh failed" 
    });
  }
};

export const logout = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (userId) {
      // Clear refresh token from database
      await User.findByIdAndUpdate(userId, {
        $unset: { refreshToken: 1 },
        $set: { isLoggedIn: false }
      });
    }

    res
      .status(200)
      .clearCookie("accessToken", cookieOptions)
      .clearCookie("refreshToken", cookieOptions)
      .json({
        success: true,
        message: "Logout successful",
      });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ 
      success: false,
      message: "Logout failed" 
    });
  }
};
export const getCurrentUser = asyncHandler(async (req, res, next) => {
  try {
    return res.status(200).json(new ApiResponse(200, req.user, "User fetched successfully..!"));
  } catch (error) {
    next(error);
  }
});
export const logoutAllDevices = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (userId) {
      // Clear refresh token from database (logs out from all devices)
      await User.findByIdAndUpdate(userId, {
        $unset: { refreshToken: 1 },
        $set: { isLoggedIn: false }
      });
    }

    res
      .status(200)
      .clearCookie("accessToken", cookieOptions)
      .clearCookie("refreshToken", cookieOptions)
      .json({
        success: true,
        message: "Logged out from all devices successfully",
      });
  } catch (error) {
    console.error("Logout all devices error:", error);
    res.status(500).json({ 
      success: false,
      message: "Logout from all devices failed" 
    });
  }
};