import { Router } from "express";
import {
  addCity,
  getCities,
  deleteCity,
  updateCity,
} from "../controller/City.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();


router.get("/", getCities);
router.post("/add", adminMiddleware, addCity);
router.delete("/:id", adminMiddleware, deleteCity);
router.patch("/:id", adminMiddleware, updateCity);

export default router;
