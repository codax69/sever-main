import express from "express";
import {
  getUser,
  getOrderHistory,
  getUserOrderHistory,
  getUserAddresses,
} from "../controller/user.controller.js";
import { verifyJWT } from "../middleware/auth.js";

const router = express.Router();

router.get("/me", verifyJWT, getUser);

router.get("/order-history", verifyJWT, getOrderHistory);

router.get("/:userId/order-history", verifyJWT, getUserOrderHistory);

router.get("/addresses", verifyJWT, getUserAddresses);

export default router;
