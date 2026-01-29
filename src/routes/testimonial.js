import express from "express";
import {
  createTestimonial,
  getPublishedTestimonials,
  getAllTestimonials,
  getTestimonialById,
  updateTestimonial,
  deleteTestimonial,
  getTestimonialStats,
} from "../controller/testimonial.js";

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = express.Router();

router.post("/", createTestimonial);
router.get("/published", getPublishedTestimonials);

router.get("/", verifyJWT, isAdmin, getAllTestimonials);
router.get("/stats", verifyJWT, isAdmin, getTestimonialStats);
router.get("/:id", verifyJWT, isAdmin, getTestimonialById);
router.patch("/:id", verifyJWT, isAdmin, updateTestimonial);
router.delete("/:id", verifyJWT, isAdmin, deleteTestimonial);

export default router;
