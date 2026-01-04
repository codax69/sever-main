import { Router } from "express";
import {
  register,
  login,
  adminLogin,
  googleAuth,
  linkGoogleAccount,
  unlinkGoogleAccount,
  refreshToken,
  logout,
  logoutAllDevices,
  getCurrentUser,
  approveUser,
  updateAvailability,
  getUsersByRole,
  updateUserStatus,
  updateProfile,
  changePassword,
  setPassword,
} from "../controller/auth.js";
import userMiddleware from "../middleware/auth.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

/* ================= PUBLIC ROUTES - USER ================= */
router.post("/register", register);
router.post("/login", login);
router.post("/google", googleAuth);
router.post("/refresh-token", refreshToken);

/* ================= PUBLIC ROUTES - ADMIN (SEPARATE) ================= */
router.post("/admin/login", adminLogin); // Dedicated admin login
router.post("/admin/google", googleAuth); // Admin Google login (can filter by role)
router.post("/admin/refresh-token", refreshToken); // Admin refresh token

/* ================= AUTHENTICATED ROUTES ================= */
router.post("/logout", userMiddleware, logout);
router.post("/logout-all", userMiddleware, logoutAllDevices);
router.get("/me", userMiddleware, getCurrentUser);
router.put("/profile", userMiddleware, updateProfile);
router.put("/change-password", userMiddleware, changePassword);
router.post("/set-password", userMiddleware, setPassword);
router.post("/google/link", userMiddleware, linkGoogleAccount);
router.post("/google/unlink", userMiddleware, unlinkGoogleAccount);

/* ================= DELIVERY PARTNER ================= */
router.put("/delivery/availability", userMiddleware, updateAvailability);

/* ================= ADMIN ONLY ================= */
router.put("/admin/approve/:userId", userMiddleware, adminMiddleware, approveUser);
router.get("/admin/users/:role", userMiddleware, adminMiddleware, getUsersByRole);
router.put("/admin/user-status/:userId", userMiddleware, adminMiddleware, updateUserStatus);

export default router;