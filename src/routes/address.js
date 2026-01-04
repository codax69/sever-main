import { Router } from "express";
import {
  getAddresses,
  getAddressById,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getDeliveryCharges,
  updateAddressLocation,
  getNearbyAddresses,
  autocompleteAddresses,
  optimizeDeliveryRoute,
  getAddressAnalytics,
} from "../controller/address.js";
import userMiddleware from "../middleware/auth.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

/* ================= USER ADDRESS ROUTES ================= */
router.get("/", userMiddleware, getAddresses);
router.get("/:addressId", userMiddleware, getAddressById);
router.post("/", userMiddleware, addAddress);
router.put("/:addressId", userMiddleware, updateAddress);
router.delete("/:addressId", userMiddleware, deleteAddress);
router.put("/:addressId/default", userMiddleware, setDefaultAddress);
router.get("/:addressId/delivery-charges", userMiddleware, getDeliveryCharges);
router.put("/:addressId/location", userMiddleware, updateAddressLocation);

/* ================= ADVANCED DSA-POWERED ROUTES ================= */
router.get("/search/autocomplete", userMiddleware, autocompleteAddresses);
router.post("/route/optimize", userMiddleware, optimizeDeliveryRoute);
router.get("/analytics/overview", userMiddleware, getAddressAnalytics);

/* ================= ADMIN UTILITY ROUTES ================= */
router.get("/admin/nearby", userMiddleware, adminMiddleware, getNearbyAddresses);

export default router;