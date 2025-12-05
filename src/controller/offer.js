import Offer from "../Model/offer.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";
import mongoose from "mongoose";

// Validation helper
const validateOfferData = (data) => {
  const { title, price, vegetables, vegetableLimit, weight, totalWeight } =
    data;

  const requiredFields = {
    title,
    price,
    vegetables,
    // vegetableLimit,
    weight,
    totalWeight,
  };
  const missingFields = Object.keys(requiredFields).filter(
    (key) =>
      requiredFields[key] === undefined ||
      requiredFields[key] === null ||
      requiredFields[key] === ""
  );

  if (missingFields.length > 0) {
    throw new ApiError(
      400,
      `Missing required fields: ${missingFields.join(", ")}`
    );
  }

  if (typeof price !== "number" || price <= 0) {
    throw new ApiError(400, "Price must be a positive number");
  }

  if (typeof totalWeight !== "number" || totalWeight <= 0) {
    throw new ApiError(400, "Total weight must be a positive number");
  }

  if (!Array.isArray(vegetables) || vegetables.length === 0) {
    throw new ApiError(400, "Vegetables must be a non-empty array");
  }
};

// Enhanced MongoDB ObjectId validation
const validateObjectId = (id, paramName = "ID") => {
  if (!id) {
    throw new ApiError(400, `${paramName} is required`);
  }
  if (typeof id !== "string") {
    throw new ApiError(400, `${paramName} must be a string`);
  }
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(
      400,
      `Invalid ${paramName} format. Expected a valid MongoDB ObjectId, received: "${id}"`
    );
  }
};

// Get all offers with optional filtering and pagination
export const getOffers = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    order = "desc",
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortOrder = order === "asc" ? 1 : -1;

  const [offers, total] = await Promise.all([
    Offer.find()
      .populate("vegetables", "name price image") // Select only needed fields
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(), // Convert to plain JS object for better performance
    Offer.countDocuments(),
  ]);

  if (!offers.length) {
    throw new ApiError(404, "No offers found");
  }

  res.json(
    new ApiResponse(
      200,
      {
        offers,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalOffers: total,
          limit: parseInt(limit),
        },
      },
      "Offers fetched successfully"
    )
  );
});

// Get offer by ID
export const getOfferById = asyncHandler(async (req, res) => {
  // Support both 'id' and '_id' parameter names
  const id = req.params._id || req.params.id;

  validateObjectId(id, "Offer ID");

  const offer = await Offer.findById(id)
    .populate("vegetables","id name image marketPrices prices stockKg outOfStock ")
    .lean();

  if (!offer) {
    throw new ApiError(404, "Offer not found");
  }

  res.json(new ApiResponse(200, offer, "Offer fetched successfully"));
});

// Add new offer
export const addOffer = asyncHandler(async (req, res) => {
  const offerData = req.body;
  // console.log(offerData)
  // Validate input data
  validateOfferData(offerData);

  // Check for duplicate title (case-insensitive)
  const existingOffer = await Offer.findOne({
    title: { $regex: new RegExp(`^${offerData.title}$`, "i") },
  });

  if (existingOffer) {
    throw new ApiError(409, "An offer with this title already exists");
  }

  // Verify all vegetables exist
  const vegetableIds = offerData.vegetables;
  const validVegetables = await mongoose.model("Vegetable").countDocuments({
    _id: { $in: vegetableIds },
  });

  if (validVegetables !== vegetableIds.length) {
    throw new ApiError(400, "One or more vegetables do not exist");
  }

  const offer = await Offer.create(offerData);
  const savedOffer = await offer.populate("vegetables");

  res
    .status(201)
    .json(new ApiResponse(201, savedOffer, "Offer added successfully"));
});

// Delete Offer
export const deleteOffer = asyncHandler(async (req, res) => {
  const id = req.params._id || req.params.id;

  validateObjectId(id, "Offer ID");

  const deletedOffer = await Offer.findByIdAndDelete(id);

  if (!deletedOffer) {
    throw new ApiError(404, "Offer not found");
  }

  res.json(new ApiResponse(200, { _id: id }, "Offer deleted successfully"));
});

// Update Offer
export const updateOffer = asyncHandler(async (req, res) => {
  const id = req.params._id || req.params.id;
  const updateData = req.body;

  validateObjectId(id, "Offer ID");
  validateOfferData(updateData);

  // Check if offer exists and check for duplicate title in one query
  const [existingOffer, duplicateOffer] = await Promise.all([
    Offer.findById(id),
    Offer.findOne({
      title: { $regex: new RegExp(`^${updateData.title}$`, "i") },
      _id: { $ne: id },
    }),
  ]);

  if (!existingOffer) {
    throw new ApiError(404, "Offer not found");
  }

  if (duplicateOffer) {
    throw new ApiError(409, "An offer with this title already exists");
  }

  // Verify vegetables exist if vegetables are being updated
  if (updateData.vegetables) {
    const validVegetables = await mongoose.model("Vegetable").countDocuments({
      _id: { $in: updateData.vegetables },
    });

    if (validVegetables !== updateData.vegetables.length) {
      throw new ApiError(400, "One or more vegetables do not exist");
    }
  }

  const updatedOffer = await Offer.findByIdAndUpdate(
    id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).populate("vegetables");

  res.json(new ApiResponse(200, updatedOffer, "Offer updated successfully"));
});

// Get top 3 most clicked offers
export const getTop3Offers = asyncHandler(async (req, res) => {
  const topOffers = await Offer.find()
    .sort({ clickCount: -1, createdAt: -1 }) // Secondary sort by creation date
    .limit(3)
    .populate("vegetables")
    .select("-__v") // Exclude version key
    .lean();

  res
    .status(200)
    .json(new ApiResponse(200, topOffers, "Top 3 offers fetched successfully"));
});

// Increment offer click count
export const incrementOfferClick = asyncHandler(async (req, res) => {
  const id = req.params._id || req.params.id;

  validateObjectId(id, "Offer ID");

  const offer = await Offer.findByIdAndUpdate(
    id,
    { $inc: { clickCount: 1 } },
    { new: true, select: "title clickCount" } // Return only necessary fields
  ).lean();

  if (!offer) {
    throw new ApiError(404, "Offer not found");
  }

  res
    .status(200)
    .json(new ApiResponse(200, offer, "Click recorded successfully"));
});

// Get all offers sorted by clicks with pagination
export const getAllOffersByClicks = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [offers, total] = await Promise.all([
    Offer.find()
      .sort({ clickCount: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("vegetables", "name price image")
      .select("-__v")
      .lean(),
    Offer.countDocuments(),
  ]);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        offers,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalOffers: total,
          limit: parseInt(limit),
        },
      },
      "Offers fetched successfully"
    )
  );
});
