import Basket from "../Model/basket.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";
import mongoose from "mongoose";

// Validation helper
const validateBasketData = (data) => {
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
      requiredFields[key] === "",
  );

  if (missingFields.length > 0) {
    throw new ApiError(
      400,
      `Missing required fields: ${missingFields.join(", ")}`,
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

  // Validate structure of each vegetable item
  vegetables.forEach((item, index) => {
    if (!item.vegetable || !item.weight) {
      throw new ApiError(
        400,
        `Vegetable at index ${index} is missing required fields (vegetable ID or weight)`,
      );
    }
  });
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
      `Invalid ${paramName} format. Expected a valid MongoDB ObjectId, received: "${id}"`,
    );
  }
};

// Get all baskets with optional filtering and pagination
export const getBaskets = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    order = "desc",
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sortOrder = order === "asc" ? 1 : -1;

  const [baskets, total] = await Promise.all([
    Basket.find()
      .populate("vegetables.vegetable", "name price image") // Select only needed fields
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(), // Convert to plain JS object for better performance
    Basket.countDocuments(),
  ]);

  if (!baskets.length) {
    throw new ApiError(404, "No baskets found");
  }

  res.json(
    new ApiResponse(
      200,
      {
        baskets,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalBaskets: total,
          limit: parseInt(limit),
        },
      },
      "Baskets fetched successfully",
    ),
  );
});

// Get basket by ID
export const getBasketById = asyncHandler(async (req, res) => {
  // Support both 'id' and '_id' parameter names
  const id = req.params._id || req.params.id;

  validateObjectId(id, "Basket ID");

  const basket = await Basket.findById(id)
    .populate(
      "vegetables.vegetable",
      "id name image marketPrices prices stockKg outOfStock stockPieces",
    )
    .lean();

  if (!basket) {
    throw new ApiError(404, "Basket not found");
  }

  res.json(new ApiResponse(200, basket, "Basket fetched successfully"));
});

// Add new basket
export const addBasket = asyncHandler(async (req, res) => {
  const basketData = req.body;
  // console.log(basketData)
  // Validate input data
  validateBasketData(basketData);

  // Check for duplicate title (case-insensitive)
  const existingBasket = await Basket.findOne({
    title: { $regex: new RegExp(`^${basketData.title}$`, "i") },
  });

  if (existingBasket) {
    throw new ApiError(409, "A basket with this title already exists");
  }

  // Verify all vegetables exist
  const vegetableIds = basketData.vegetables.map((v) => v.vegetable);
  const validVegetables = await mongoose.model("Vegetable").countDocuments({
    _id: { $in: vegetableIds },
  });

  if (validVegetables !== vegetableIds.length) {
    throw new ApiError(400, "One or more vegetables do not exist");
  }

  const basket = await Basket.create(basketData);
  const savedBasket = await basket.populate("vegetables.vegetable");

  res
    .status(201)
    .json(new ApiResponse(201, savedBasket, "Basket added successfully"));
});

// Delete Basket
export const deleteBasket = asyncHandler(async (req, res) => {
  const id = req.params._id || req.params.id;

  validateObjectId(id, "Basket ID");

  const deletedBasket = await Basket.findByIdAndDelete(id);

  if (!deletedBasket) {
    throw new ApiError(404, "Basket not found");
  }

  res.json(new ApiResponse(200, { _id: id }, "Basket deleted successfully"));
});

// Update Basket
export const updateBasket = asyncHandler(async (req, res) => {
  const id = req.params._id || req.params.id;
  const updateData = req.body;

  validateObjectId(id, "Basket ID");
  validateBasketData(updateData);

  // Check if basket exists and check for duplicate title in one query
  const [existingBasket, duplicateBasket] = await Promise.all([
    Basket.findById(id),
    Basket.findOne({
      title: { $regex: new RegExp(`^${updateData.title}$`, "i") },
      _id: { $ne: id },
    }),
  ]);

  if (!existingBasket) {
    throw new ApiError(404, "Basket not found");
  }

  if (duplicateBasket) {
    throw new ApiError(409, "A basket with this title already exists");
  }

  // Verify vegetables exist if vegetables are being updated
  if (updateData.vegetables) {
    const vegetableIds = updateData.vegetables.map((v) => v.vegetable);
    const validVegetables = await mongoose.model("Vegetable").countDocuments({
      _id: { $in: vegetableIds },
    });

    if (validVegetables !== updateData.vegetables.length) {
      throw new ApiError(400, "One or more vegetables do not exist");
    }
  }

  const updatedBasket = await Basket.findByIdAndUpdate(
    id,
    { $set: updateData },
    { new: true, runValidators: true },
  ).populate("vegetables.vegetable");

  res.json(new ApiResponse(200, updatedBasket, "Basket updated successfully"));
});

// Get top 3 most clicked baskets
export const getTop3Baskets = asyncHandler(async (req, res) => {
  const topBaskets = await Basket.find()
    .sort({ clickCount: -1, createdAt: -1 }) // Secondary sort by creation date
    .limit(3)
    .populate("vegetables.vegetable")
    .select("-__v") // Exclude version key
    .lean();

  res
    .status(200)
    .json(
      new ApiResponse(200, topBaskets, "Top 3 baskets fetched successfully"),
    );
});

// Increment basket click count
export const incrementBasketClick = asyncHandler(async (req, res) => {
  const id = req.params._id || req.params.id;

  validateObjectId(id, "Basket ID");

  const basket = await Basket.findByIdAndUpdate(
    id,
    { $inc: { clickCount: 1 } },
    { new: true, select: "title clickCount" }, // Return only necessary fields
  ).lean();

  if (!basket) {
    throw new ApiError(404, "Basket not found");
  }

  res
    .status(200)
    .json(new ApiResponse(200, basket, "Click recorded successfully"));
});

// Get all baskets sorted by clicks with pagination
export const getAllBasketsByClicks = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [baskets, total] = await Promise.all([
    Basket.find()
      .sort({ clickCount: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("vegetables.vegetable", "name price image")
      .select("-__v")
      .lean(),
    Basket.countDocuments(),
  ]);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        baskets,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalBaskets: total,
          limit: parseInt(limit),
        },
      },
      "Baskets fetched successfully",
    ),
  );
});
