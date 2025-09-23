import Vegetable from "../Model/vegetable.js";
import { ApiResponse } from "../utility/ApiRespoense.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { uploadToCloudinary } from "../utility/cloudinary.js";


export const getVegetables = asyncHandler(async (req, res) => {
  const vegetables = await Vegetable.find();
  res.json(new ApiResponse(200, vegetables, "Vegetables fetched successfully"));
});


export const getVegetableById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const vegetable = await Vegetable.findById(id);
  if (!vegetable) {
    return res
      .status(404)
      .json(new ApiResponse(404, null, "Vegetable not found"));
  }
  res.json(new ApiResponse(200, vegetable, "Vegetable fetched successfully"));
});


export const addVegetable = asyncHandler(async (req, res) => {
  const { screenNumber, price, offer, description, stockKg, image, name } =
    req.body;
  console.log({ name, image, price, stockKg, screenNumber });
  if (!name || !price || !stockKg) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Missing required fields"));
  }
  const vegetable = new Vegetable({
    screenNumber,
    price,
    offer,
    description,
    stockKg,
    image,
    name,
  });
  await vegetable.save();
  res.json(new ApiResponse(201, vegetable, "Vegetable added successfully"));
});

// Delete Vegetable
export const deleteVegetable = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await Vegetable.findByIdAndDelete(id);
  if (!result) {
    return res
      .status(404)
      .json(new ApiResponse(404, null, "Vegetable not found"));
  }
  res.json(new ApiResponse(200, result, "Vegetable deleted successfully"));
});

// Update Vegetable
export const updateVegetable = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  const vegetable = await Vegetable.findByIdAndUpdate(id, updateData, {
    new: true,
  });
  if (!vegetable) {
    return res
      .status(404)
      .json(new ApiResponse(404, null, "Vegetable not found"));
  }
  res.json(new ApiResponse(200, vegetable, "Vegetable updated successfully"));
});
