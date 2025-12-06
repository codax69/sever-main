import { Router } from "express";
import {
  addVegetable,
  deleteVegetable,
  updateVegetable,
  getVegetables,
  getVegetableById,
  homepageApi
} from "../controller/vegetable.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Public routes - accessible by all users
router.get("/", getVegetables);
router.get("/home/veg", homepageApi);
router.get("/:id", getVegetableById);
// Protected routes - only admin can access
router.post(
  "/add",
  addVegetable
);
router.delete("/:id", deleteVegetable);
router.patch("/:id" , updateVegetable);
router.post(
  "/add",
  adminMiddleware,
  addVegetable
);
router.delete("/:id", adminMiddleware, deleteVegetable);
router.put("/:id", adminMiddleware, updateVegetable);

export default router;
