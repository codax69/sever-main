import { Router } from "express";
import {
  getOffers,
  getOfferById,
  addOffer,
  deleteOffer,
  updateOffer,
  getTop3Offers,
  incrementOfferClick,
  getAllOffersByClicks,
} from "../controller/offer.js";

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

router.get("/", getOffers);
router.get("/top-offers/suggestion", getTop3Offers);
router.get("/all/offers-click", getAllOffersByClicks);
router.get("/:_id", getOfferById);

router.post("/click/:_id", incrementOfferClick);

router.post("/add", verifyJWT, isAdmin, addOffer);
router.patch("/:_id", verifyJWT, isAdmin, updateOffer);
router.delete("/:_id", verifyJWT, isAdmin, deleteOffer);

export default router;
