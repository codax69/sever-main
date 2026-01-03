import { Router } from "express";
import {
  getOrderHistory,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} from "../controller/user.controller.js";
import userMiddleware from "../middleware/auth.js";

const router = Router();

/* ================= USER ORDER HISTORY ROUTES ================= */
router.get("/orders", userMiddleware, getOrderHistory);

/* ================= USER ADDRESS ROUTES ================= */
router.get("/addresses", userMiddleware, getAddresses);
router.post("/addresses", userMiddleware, addAddress);
router.put("/addresses/:addressId", userMiddleware, updateAddress);
router.delete("/addresses/:addressId", userMiddleware, deleteAddress);
router.put("/addresses/:addressId/default", userMiddleware, setDefaultAddress);

export default router;