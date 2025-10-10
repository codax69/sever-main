import Offer from "../Model/offer.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";

// Validation helper
const validateOfferData = (data) => {
  const { title, price, vegetables, vegetableLimit } = data;

  if (!title || typeof title !== "string") {
    throw new ApiError(400, "Valid title is required");
  }

  if (!price || isNaN(price) || price <= 0) {
    throw new ApiError(400, "Valid price is required");
  }

  if (!Array.isArray(vegetables) || vegetables.length === 0) {
    throw new ApiError(400, "At least one vegetable must be included");
  }

  if (!vegetableLimit || isNaN(vegetableLimit) || vegetableLimit <= 0) {
    throw new ApiError(400, "Valid vegetable limit is required");
  }
};

// Get all offers
export const getOffers = asyncHandler(async (req, res) => {
  const offers = await Offer.find()
    .populate("vegetables")
    .sort({ createdAt: -1 });

  if (!offers.length) {
    throw new ApiError(404, "No offers found");
  }

  res.json(new ApiResponse(200, offers, "Offers fetched successfully"));
});

// Get offer by ID
export const getOfferById = asyncHandler(async (req, res) => {
  const { _id } = req.params;

  if (!_id) {
    throw new ApiError(400, "Offer ID is required");
  }

  const offer = await Offer.findById(_id).populate("vegetables");

  if (!offer) {
    throw new ApiError(404, "Offer not found");
  }

  res.json(new ApiResponse(200, offer, "Offer fetched successfully"));
});

// Add new offer
export const addOffer = asyncHandler(async (req, res) => {
  const offerData = req.body;

  // Validate input data
  validateOfferData(offerData);

  // Check for duplicate title
  const existingOffer = await Offer.findOne({ title: offerData.title });
  if (existingOffer) {
    throw new ApiError(400, "An offer with this title already exists");
  }

  const offer = new Offer(offerData);
  await offer.save();

  const savedOffer = await offer.populate("vegetables");

  res
    .status(201)
    .json(new ApiResponse(201, savedOffer, "Offer added successfully"));
});

// Delete Offer
export const deleteOffer = asyncHandler(async (req, res) => {
  const { _id } = req.params;

  if (!_id) {
    throw new ApiError(400, "Offer ID is required");
  }

  const offer = await Offer.findById(_id);
  if (!offer) {
    throw new ApiError(404, "Offer not found");
  }

  await Offer.findByIdAndDelete(_id);

  res.json(new ApiResponse(200, null, "Offer deleted successfully"));
});

// Update Offer
export const updateOffer = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const updateData = req.body;

  if (!_id) {
    throw new ApiError(400, "Offer ID is required");
  }

  // Validate update data
  validateOfferData(updateData);


  const existingOffer = await Offer.findById(_id);
  if (!existingOffer) {
    throw new ApiError(404, "Offer not found");
  }

  const duplicateOffer = await Offer.findOne({
    title: updateData.title,
    _id: { $ne: _id },
  });
  if (duplicateOffer) {
    throw new ApiError(400, "An offer with this title already exists");
  }

  const updatedOffer = await Offer.findByIdAndUpdate(
    _id,
    { $set: updateData },
    { new: true }
  ).populate("vegetables");

  res.json(new ApiResponse(200, updatedOffer, "Offer updated successfully"));
});
