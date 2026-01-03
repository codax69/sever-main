import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../Model/user.js";
import "dotenv/config";

/**
 * Hash token for comparison with stored hashed tokens
 */
const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

/**
 * Admin Middleware - Verify JWT Token and Authenticate User
 * This middleware checks if user is authenticated and token is valid
 */
const adminMiddleware = async (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    let token = req.cookies?.accessToken;
    
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access token is required. Please login.",
      });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Access token has expired. Please refresh your token.",
          expired: true,
        });
      }
      return res.status(401).json({
        success: false,
        message: "Invalid access token.",
      });
    }

    // Check if token type is correct
    if (decoded.type !== "access") {
      return res.status(401).json({
        success: false,
        message: "Invalid token type.",
      });
    }

    // Hash the token to compare with stored hash
    const hashedToken = hashToken(token);

    // Find user and verify token is still valid
    const user = await User.findOne({
      _id: decoded.id,
      accessToken: hashedToken,
      isLoggedIn: true,
    }).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found or session expired. Please login again.",
      });
    }

    // Check if user account is active
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact support.",
      });
    }

    // Check if user needs approval (for special roles)
    if (
      ["delivery_partner", "packaging", "editor"].includes(user.role) &&
      !user.isApproved
    ) {
      return res.status(403).json({
        success: false,
        message: "Your account is pending approval.",
        needsApproval: true,
      });
    }

    // Attach user to request object
    req.user = {
      id: user._id,
      email: user.email,
      role: user.role,
      username: user.username,
      isApproved: user.isApproved,
      isActive: user.isActive,
    };

    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Authentication failed.",
      error: error.message,
    });
  }
};

/**
 * Authorize Roles Middleware
 * Checks if user has one of the required roles
 * Usage: authorizeRoles("admin", "editor")
 */
export const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${roles.join(", ")}. Your role: ${req.user.role}`,
      });
    }

    next();
  };
};

/**
 * Optional Authentication Middleware
 * Attaches user to request if token is valid, but doesn't require it
 */
export const optionalAuth = async (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    let token = req.cookies?.accessToken;
    
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      }
    }

    // If no token, just continue without authentication
    if (!token) {
      return next();
    }

    // Try to verify token
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      if (decoded.type === "access") {
        const hashedToken = hashToken(token);
        const user = await User.findOne({
          _id: decoded.id,
          accessToken: hashedToken,
          isLoggedIn: true,
          isActive: true,
        }).select("-password -refreshToken -accessToken");

        if (user) {
          req.user = {
            id: user._id,
            email: user.email,
            role: user.role,
            username: user.username,
            isApproved: user.isApproved,
            isActive: user.isActive,
          };
        }
      }
    } catch (error) {
      // Token is invalid or expired, but that's okay for optional auth
      console.log("Optional auth: Invalid or expired token");
    }

    next();
  } catch (error) {
    // If there's an error, just continue without authentication
    next();
  }
};

export default adminMiddleware;