import express from "express";
import rateLimit from "express-rate-limit";
import {
  // User Authentication (Simple - No Email Verification)
  register,
  login,
  googleAuth,

  // Admin Authentication (With Email Verification)
  adminRegister,
  adminLogin,
  verifyEmail,
  resendVerificationEmail,

  // Password Management
  forgotPassword,
  resetPassword,
  changePassword,

  // Token Management
  refreshToken,
  logout,

  // Profile Management
  getCurrentUser,
  updateProfile,

  // Admin User Management
  getAllUsers,
  updateUserStatus,
  deleteUser,
} from "../Controller/auth.js";

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = express.Router();

// ============= RATE LIMITERS =============

// Strict rate limiter for authentication attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: {
    statusCode: 429,
    message: "Too many login attempts. Please try again after 15 minutes.",
    success: false,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for password reset requests
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 requests per window
  message: {
    statusCode: 429,
    message: "Too many password reset attempts. Please try again after 15 minutes.",
    success: false,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for email verification resend
const emailVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per hour
  message: {
    statusCode: 429,
    message: "Too many verification email requests. Please try again after 1 hour.",
    success: false,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// General registration limiter
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 registrations per hour from same IP
  message: {
    statusCode: 429,
    message: "Too many accounts created. Please try again after 1 hour.",
    success: false,
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============= PUBLIC ROUTES =============

// User Authentication (No Email Verification Required)
router.post("/register", registrationLimiter, register);
router.post("/login", authLimiter, login);
router.post("/google", authLimiter, googleAuth);

// Admin Authentication (Email Verification Required)
router.post("/admin/register", registrationLimiter, adminRegister);
router.post("/admin/login", authLimiter, adminLogin);

// Email Verification (Admin Only)
router.get("/verify-email/:token", verifyEmail);
router.post("/resend-verification", emailVerificationLimiter, resendVerificationEmail);

// Password Management (Public)
router.post("/forgot-password", passwordResetLimiter, forgotPassword);
router.post("/reset-password/:token", resetPassword);

// Token Refresh
router.post("/refresh-token", refreshToken);

// ============= PROTECTED ROUTES =============

// Authentication Required
router.post("/logout", verifyJWT, logout);
router.get("/me", verifyJWT, getCurrentUser);
router.put("/profile", verifyJWT, updateProfile);
router.put("/change-password", verifyJWT, changePassword);

// ============= ADMIN ROUTES =============

// User Management (Admin Only)
router.get("/users", verifyJWT, isAdmin, getAllUsers);
router.patch("/users/:userId/status", verifyJWT, isAdmin, updateUserStatus);
router.delete("/users/:userId", verifyJWT, isAdmin, deleteUser);

export default router;