import { Router } from "express";
import {
  getOffers,
  getOfferById,
  addOffer,
  deleteOffer,
  updateOffer
} from "../controller/offer.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();


router.get("/", getOffers);
router.get("/:_id", getOfferById);

router.post("/add", adminMiddleware, addOffer);
router.delete("/:_id", adminMiddleware, deleteOffer);
router.put("/:_id", adminMiddleware, updateOffer);

export default router;