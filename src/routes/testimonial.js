import express from "express";
import {
  createTestimonial,
  getPublishedTestimonials,
  getAllTestimonials,
  getTestimonialById,
  updateTestimonial,
  deleteTestimonial,
  getTestimonialStats
} from "../controller/testimonial.js";

// import { verifyJWT, isAdmin } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public
router.post("/", createTestimonial);
router.get("/published", getPublishedTestimonials);

// Admin (for now, open for development)
router.get("/", getAllTestimonials);
router.get("/stats", getTestimonialStats);
router.get("/:id", getTestimonialById);
router.patch("/:id", updateTestimonial);
router.delete("/:id", deleteTestimonial);

// Uncomment these lines when JWT middleware is ready
// router.get("/", verifyJWT, isAdmin, getAllTestimonials);
// router.get("/stats", verifyJWT, isAdmin, getTestimonialStats);
// router.get("/:id", verifyJWT, isAdmin, getTestimonialById);
// router.patch("/:id", verifyJWT, isAdmin, updateTestimonial);
// router.delete("/:id", verifyJWT, isAdmin, deleteTestimonial);

export default router;
