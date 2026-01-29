import { Router } from "express";
import {
  addCity,
  getCities,
  deleteCity,
  updateCity,
} from "../controller/City.js";

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

/* =======================
   PUBLIC ROUTES
======================= */

router.get("/", getCities);

/* =======================
   ADMIN ROUTES
======================= */

router.post("/add", verifyJWT, isAdmin, addCity);
router.delete("/:id", verifyJWT, isAdmin, deleteCity);
router.patch("/:id", verifyJWT, isAdmin, updateCity);

export default router;
