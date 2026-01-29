import { Router } from "express";
import {
  getAddresses,
  getAllUserAddresses,
  getActiveAddresses,
  getAddressesByUserId,
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

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

// ============= ADMIN ONLY ROUTES =============
router.get("/analytics/overview", verifyJWT, isAdmin, getAddressAnalytics);

router.get("/admin/nearby", verifyJWT, isAdmin, getNearbyAddresses);

// ============= AUTHENTICATED USER ROUTES =============
router.get("/search/autocomplete", verifyJWT, autocompleteAddresses);

router.post("/route/optimize", verifyJWT, optimizeDeliveryRoute);

// Get addresses with filters and pagination (most flexible)
router.get("/", verifyJWT, getAddresses);

// Get all user addresses (simple, no filters)
router.get("/all", verifyJWT, getAllUserAddresses);

// Get only active addresses
router.get("/active", verifyJWT, getActiveAddresses);

// Get addresses by specific user ID
router.get("/user/:userId", verifyJWT, getAddressesByUserId);

router.post("/add", verifyJWT, addAddress);

router.put("/:addressId", verifyJWT, updateAddress);

router.delete("/:addressId", verifyJWT, deleteAddress);

router.put("/:addressId/default", verifyJWT, setDefaultAddress);

router.get("/:addressId/delivery-charges", verifyJWT, getDeliveryCharges);

router.put("/:addressId/location", verifyJWT, updateAddressLocation);

export default router;
