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
import adminMiddleware from "../middleware/admin.js";

const router = Router();

router.get("/", getOffers);
router.get("/:_id", getOfferById);

router.post("/add", adminMiddleware, addOffer);
router.delete("/:_id", adminMiddleware, deleteOffer);
router.patch("/:_id", adminMiddleware, updateOffer);

//suggestion route can be added here in future
router.get("/Top-offers/suggestion", getTop3Offers);
router.post("/click/:_id", incrementOfferClick);
router.get("/all/offers-click", getAllOffersByClicks);
export default router;
