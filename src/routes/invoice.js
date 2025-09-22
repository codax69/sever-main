// routes/invoiceRoutes.js
import express from "express";
import { invoiceController } from "../controller/invoice.js";
const router = express.Router();

// Generate and send invoice for a given orderId
router.post("/send/:orderId", invoiceController);

export default router;
