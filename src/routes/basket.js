import { Router } from "express";
import {
  getBaskets,
  getBasketById,
  addBasket,
  deleteBasket,
  updateBasket,
  getTop3Baskets,
  incrementBasketClick,
  getAllBasketsByClicks,
} from "../controller/basket.js";

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

router.get("/", getBaskets);
router.get("/top-baskets/suggestion", getTop3Baskets);
router.get("/all/baskets-click", getAllBasketsByClicks);
router.get("/:_id", getBasketById);

router.post("/click/:_id", incrementBasketClick);

router.post("/add", verifyJWT, isAdmin, addBasket);
router.patch("/:_id", verifyJWT, isAdmin, updateBasket);
router.delete("/:_id", verifyJWT, isAdmin, deleteBasket);

export default router;
