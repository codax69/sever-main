import Offer from "../Model/offer.js";
import { ApiResponse } from "../utility/ApiRespoense.js";
import { asyncHandler } from "../utility/AsyncHandler.js";

// Get all offers
export const getOffers = asyncHandler(async (req, res) => {
  const offers = await Offer.find().populate("vegetables"); // populate vegetable details
  res.json(new ApiResponse(200, offers, "Offers fetched successfully"));
});

// Get offer by ID
export const getOfferById = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const offer = await Offer.findById(_id).populate("vegetables"); // populate here too
  if (!offer) {
    return res.status(404).json(new ApiResponse(404, null, "Offer not found"));
  }
  res.json(new ApiResponse(200, offer, "Offer fetched successfully"));
});

// Add Offer
export const addOffer = asyncHandler(async (req, res) => {
  const { id, title, price, description, vegetables, vegetableLimit } =
    req.body;

  const offer = new Offer({
    id,
    title,
    price,
    description,
    vegetables, // must be ObjectIds of vegetables
    vegetableLimit,
  });

  await offer.save();
  const savedOffer = await offer.populate("vegetables"); // return populated version

  res.json(new ApiResponse(201, savedOffer, "Offer added successfully"));
});

// Delete Offer
export const deleteOffer = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const result = await Offer.findByIdAndDelete(_id).populate("vegetables");
  if (!result) {
    return res.status(404).json(new ApiResponse(404, null, "Offer not found"));
  }
  res.json(new ApiResponse(200, result, "Offer deleted successfully"));
});

// Update Offer
export const updateOffer = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { vegetables, price, description, title, vegetableLimit } = req.body;

  const offer = await Offer.findByIdAndUpdate(
    _id,
    { vegetables, price, description, title, vegetableLimit },
    { new: true }
  ).populate("vegetables");

  if (!offer) {
    return res.status(404).json(new ApiResponse(404, null, "Offer not found"));
  }

  res.json(new ApiResponse(200, offer, "Offer updated successfully"));
});
