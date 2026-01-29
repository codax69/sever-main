import { Router } from "express";
import {
  getOrders,
  getOrderById,
  addOrder,
  verifyPayment,
  getRazorpayKey,
  calculateTodayOrderTotal,
  calculatePrice,
  updateOrderStatus,
  validateCouponForBasket,
  getOrdersByDateTimeRange,
  getOrdersByStatus,
  getOrdersByMultipleStatuses,
  getOrderStatusStats,
} from "../controller/order.js";

import { verifyJWT, isAdmin, optionalAuth } from "../middleware/auth.js";

// Custom role-based authorization middleware
const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, "Authentication required");
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ApiError(
        403,
        `Access denied. Required roles: ${allowedRoles.join(", ")}`,
      );
    }

    next();
  };
};

const router = Router();

// ============= PUBLIC ROUTES =============
// No authentication required
router.get("/get-key", getRazorpayKey);
router.post("/calculate-price", calculatePrice);
router.post("/validate-coupon-basket", validateCouponForBasket);

// ============= AUTHENTICATED USER ROUTES =============
// Any logged-in user can access
router.post("/create-order", verifyJWT, addOrder);
router.post("/verify-payment", verifyJWT, verifyPayment);

router.get(
  "/all",
  verifyJWT,
  authorizeRoles("admin", "editor", "packaging", "delivery_partner"),
  getOrders,
);
router.get("/:orderId", verifyJWT, getOrderById);

// ============= ADMIN & EDITOR ROUTES =============
// Admin and Editor roles only
router.get("/today/total", calculateTodayOrderTotal);

router.get(
  "/date-range",
  verifyJWT,
  authorizeRoles("admin", "editor"),
  getOrdersByDateTimeRange,
);

router.get(
  "/statuses/multiple",
  verifyJWT,
  authorizeRoles("admin", "editor"),
  getOrdersByMultipleStatuses,
);

router.get(
  "/stats/status",
  verifyJWT,
  authorizeRoles("admin", "editor"),
  getOrderStatusStats,
);

// ============= MULTI-ROLE ACCESS ROUTES =============
// Admin, Editor, Packaging, Delivery Partner
router.get(
  "/status/:status",
  verifyJWT,
  authorizeRoles("admin", "editor", "packaging", "delivery_partner"),
  getOrdersByStatus,
);

// ============= STATUS UPDATE ROUTES =============
// Admin, Packaging, Delivery Partner
router.patch(
  "/:_id/status",
  verifyJWT,
  authorizeRoles("admin", "delivery_partner", "packaging"),
  updateOrderStatus,
);

// ============= ADMIN ONLY ROUTES =============
// Only admin can update or delete orders
router.patch("/:id", verifyJWT, isAdmin);

router.delete("/:id", verifyJWT, isAdmin);

export default router;
