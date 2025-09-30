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
  const { price, stockKg,image } = req.body;
  if (price === undefined && stockKg === undefined && image===undefined) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "At least one field (price or stockKg) is required"));
  }
  if (price !== undefined && (isNaN(price) || price < 0)) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Price must be a valid positive number"));
  }

  if (stockKg !== undefined && (isNaN(stockKg) || stockKg < 0)) {
    return res
      .status(400)
      .json(new ApiResponse(400, null, "Stock must be a valid positive number"));
  }
  
  const updateData = {};
  if (price !== undefined) updateData.price = parseFloat(price);
  if (stockKg !== undefined) updateData.stockKg = parseFloat(stockKg);
  if(image!==undefined){updateData.image=image}
  try {
    const vegetable = await Vegetable.findByIdAndUpdate(id, updateData, {
      new: true, 
      runValidators: true, 
    });

    if (!vegetable) {
      return res
        .status(404)
        .json(new ApiResponse(404, null, "Vegetable not found"));
    }

    res.json(new ApiResponse(200, vegetable, "Vegetable updated successfully"));
  } catch (error) {
    if (error.name === 'CastError') {
      return res
        .status(400)
        .json(new ApiResponse(400, null, "Invalid vegetable ID format"));
    }
    
   
    if (error.name === 'ValidationError') {
      return res
        .status(400)
        .json(new ApiResponse(400, null, error.message));
    }

    throw error;
  }
});