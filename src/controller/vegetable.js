import Vegetable from "../Model/vegetable.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
// import { uploadToCloudinary } from "../utility/cloudinary.js";

// Helper function to calculate prices based on 1kg price
const calculatePrices = (price1kg) => {
  const p = parseFloat(price1kg);
  return {
    weight1kg: p,
    weight500g: Math.round((p / 2) * 100) / 100,
    weight250g: Math.round((p / 4) * 100) / 100,
    weight100g: Math.round((p / 10) * 100) / 100,
  };
};

export const getVegetables = asyncHandler(async (req, res) => {
  const vegetables = await Vegetable.find();
  
  // Transform data to include weight options for frontend dropdown
  const vegetablesWithWeightOptions = vegetables.map(veg => ({
    ...veg.toObject(),
    weightOptions: [
      { weight: '1kg', price: veg.prices.weight1kg, marketPrice: veg.marketPrices.weight1kg },
      { weight: '500g', price: veg.prices.weight500g, marketPrice: veg.marketPrices.weight500g },
      { weight: '250g', price: veg.prices.weight250g, marketPrice: veg.marketPrices.weight250g },
      { weight: '100g', price: veg.prices.weight100g, marketPrice: veg.marketPrices.weight100g },
    ]
  }));
  
  res.json(new ApiResponse(200, vegetablesWithWeightOptions, "Vegetables fetched successfully"));
});

export const getVegetableById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const vegetable = await Vegetable.findById(id);
  if (!vegetable) {
    return res
      .status(404)
      .json(new ApiResponse(404, null, "Vegetable not found"));
  }
  
  // Add weight options for dropdown
  const vegetableWithWeightOptions = {
    ...vegetable.toObject(),
    weightOptions: [
      { weight: '1kg', price: vegetable.prices.weight1kg, marketPrice: vegetable.marketPrices.weight1kg },
      { weight: '500g', price: vegetable.prices.weight500g, marketPrice: vegetable.marketPrices.weight500g },
      { weight: '250g', price: vegetable.prices.weight250g, marketPrice: vegetable.marketPrices.weight250g },
      { weight: '100g', price: vegetable.prices.weight100g, marketPrice: vegetable.marketPrices.weight100g },
    ]
  };
  
  res.json(new ApiResponse(200, vegetableWithWeightOptions, "Vegetable fetched successfully"));
});

export const addVegetable = asyncHandler(async (req, res) => {
  const {
    screenNumber,
    price1kg,        // Single input field for VegBazar 1kg price
    marketPrice1kg,  // Single input field for Market 1kg price
    offer,
    description,
    stockKg,
    image,
    name,
  } = req.body;

  // Validation
  if (!name || !price1kg || !marketPrice1kg || !stockKg) {
    return res
      .status(400)
      .json(
        new ApiResponse(
          400,
          null,
          "Missing required fields: name, price1kg, marketPrice1kg, stockKg"
        )
      );
  }

  // Validate 1kg price
  if (isNaN(price1kg) || parseFloat(price1kg) <= 0) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "VegBazar price must be a valid positive number")
      );
  }

  // Validate market 1kg price
  if (isNaN(marketPrice1kg) || parseFloat(marketPrice1kg) <= 0) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "Market price must be a valid positive number")
      );
  }

  if (isNaN(stockKg) || parseFloat(stockKg) <= 0) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "Stock must be a valid positive number")
      );
  }

  // Auto-calculate all weight prices
  const prices = calculatePrices(price1kg);
  const marketPrices = calculatePrices(marketPrice1kg);

  const vegetable = new Vegetable({
    screenNumber,
    prices,
    marketPrices,
    offer,
    description,
    stockKg: parseFloat(stockKg),
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
  const { 
    price1kg,        // Single input for VegBazar 1kg price
    marketPrice1kg,  // Single input for Market 1kg price
    stockKg, 
    image, 
    name,
    offer, 
    description, 
    screenNumber 
  } = req.body;

  // console.log(price1kg, marketPrice1kg, stockKg, image, name, offer, description, screenNumber);

  if (
    price1kg === undefined &&
    marketPrice1kg === undefined &&
    stockKg === undefined &&
    image === undefined &&
    name === undefined &&
    offer === undefined &&
    description === undefined &&
    screenNumber === undefined
  ) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "At least one field is required for update")
      );
  }

  // Validate price1kg if provided
  if (price1kg !== undefined && (isNaN(price1kg) || parseFloat(price1kg) <= 0)) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "VegBazar price must be a valid positive number")
      );
  }

  // Validate marketPrice1kg if provided
  if (marketPrice1kg !== undefined && (isNaN(marketPrice1kg) || parseFloat(marketPrice1kg) <= 0)) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "Market price must be a valid positive number")
      );
  }

  if (stockKg !== undefined && (isNaN(stockKg) || parseFloat(stockKg) <= 0)) {
    return res
      .status(400)
      .json(
        new ApiResponse(400, null, "Stock must be a valid positive number")
      );
  }

  const updateData = {};

  // Auto-calculate all weight prices if price1kg is provided
  if (price1kg !== undefined) {
    updateData.prices = calculatePrices(price1kg);
  }

  // Auto-calculate all weight market prices if marketPrice1kg is provided
  if (marketPrice1kg !== undefined) {
    updateData.marketPrices = calculatePrices(marketPrice1kg);
  }

  if (stockKg !== undefined) updateData.stockKg = parseFloat(stockKg);
  if (image !== undefined) updateData.image = image;
  if (name !== undefined) updateData.name = name;
  if (offer !== undefined) updateData.offer = offer;
  if (description !== undefined) updateData.description = description;
  if (screenNumber !== undefined) updateData.screenNumber = screenNumber;

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
    if (error.name === "CastError") {
      return res
        .status(400)
        .json(new ApiResponse(400, null, "Invalid vegetable ID format"));
    }

    if (error.name === "ValidationError") {
      return res
        .status(400)
        .json(new ApiResponse(400, null, error.message));
    }

    throw error;
  }
});