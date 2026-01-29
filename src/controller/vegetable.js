import Vegetable from "../Model/vegetable.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";

// Cache for frequently accessed data
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Optimized price calculation using bit operations for rounding
const calculatePrices = (price1kg) => {
  const p = price1kg;
  return {
    weight1kg: p,
    weight500g: (p * 0.54) | 0,
    weight250g: (p * 0.32) | 0,
    weight100g: (p * 0.12) | 0,
  };
};

const calculateMarketPrices = (price1kg) => {
  const p = price1kg;
  return {
    weight1kg: p,
    weight500g: (p * 0.60) | 0,
    weight250g: (p * 0.40) | 0,
    weight100g: (p * 0.20) | 0,
  };
};

// Optimized formatting using object pooling pattern
const formatVegetableWithOptions = (veg) => {
  const vegObject = veg.toObject ? veg.toObject() : veg;
  
  if (vegObject.setPricing?.enabled && vegObject.setPricing.sets?.length > 0) {
    return {
      ...vegObject,
      pricingType: 'set',
      setOptions: vegObject.setPricing.sets.map(set => ({
        quantity: set.quantity,
        unit: set.unit,
        price: set.price,
        marketPrice: set.marketPrice,
        label: set.label || `${set.quantity} ${set.unit}`,
      })),
    };
  }
  
  return {
    ...vegObject,
    pricingType: 'weight',
    weightOptions: [
      { weight: '1kg', price: vegObject.prices.weight1kg, marketPrice: vegObject.marketPrices.weight1kg },
      { weight: '500g', price: vegObject.prices.weight500g, marketPrice: vegObject.marketPrices.weight500g },
      { weight: '250g', price: vegObject.prices.weight250g, marketPrice: vegObject.marketPrices.weight250g },
      { weight: '100g', price: vegObject.prices.weight100g, marketPrice: vegObject.marketPrices.weight100g },
    ],
  };
};

// Fisher-Yates shuffle - O(n) time complexity
const shuffleArray = (array) => {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// Quick Sort implementation for custom sorting - O(n log n) average
const quickSort = (arr, compareFn) => {
  if (arr.length <= 1) return arr;
  
  const pivot = arr[Math.floor(arr.length / 2)];
  const left = arr.filter((item, idx) => idx !== Math.floor(arr.length / 2) && compareFn(item, pivot) < 0);
  const middle = arr.filter((item, idx) => idx === Math.floor(arr.length / 2) || compareFn(item, pivot) === 0);
  const right = arr.filter((item, idx) => idx !== Math.floor(arr.length / 2) && compareFn(item, pivot) > 0);
  
  return [...quickSort(left, compareFn), ...middle, ...quickSort(right, compareFn)];
};

// Binary search for finding vegetable by ID in sorted array - O(log n)
const binarySearch = (arr, id) => {
  let left = 0;
  let right = arr.length - 1;
  
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const midId = arr[mid]._id.toString();
    
    if (midId === id) return arr[mid];
    if (midId < id) left = mid + 1;
    else right = mid - 1;
  }
  return null;
};

// Heap-based priority queue for featured/popular items - O(log n) operations
class MinHeap {
  constructor(compareFn) {
    this.heap = [];
    this.compareFn = compareFn;
  }
  
  push(val) {
    this.heap.push(val);
    this.bubbleUp(this.heap.length - 1);
  }
  
  bubbleUp(idx) {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.compareFn(this.heap[idx], this.heap[parentIdx]) >= 0) break;
      [this.heap[idx], this.heap[parentIdx]] = [this.heap[parentIdx], this.heap[idx]];
      idx = parentIdx;
    }
  }
  
  toArray() {
    return this.heap.sort(this.compareFn);
  }
}

export const getVegetables = asyncHandler(async (req, res) => {
  const { sortBy, order, featured, popular, random, inStock, limit } = req.query;
  
  const cacheKey = JSON.stringify(req.query);
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(new ApiResponse(200, cached.data, "Vegetables fetched from cache"));
  }
  
  let query = Vegetable.find();
  
  if (featured === 'true') {
    query = query.where('isFeatured').equals(true);
  }
  
  if (inStock === 'true') {
    query = query.where('outOfStock').equals(false);
  }
  
  let vegetables = await query.lean();
  
  if (random === 'true') {
    vegetables = shuffleArray(vegetables);
  } else if (popular === 'true') {
    vegetables = quickSort(vegetables, (a, b) => {
      return (b.salesCount || 0) - (a.salesCount || 0) || (b.views || 0) - (a.views || 0);
    });
  } else if (sortBy) {
    const sortOrder = order === 'desc' ? -1 : 1;
    vegetables = quickSort(vegetables, (a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return sortOrder * (aVal > bVal ? 1 : aVal < bVal ? -1 : 0);
    });
  }
  
  if (limit) {
    vegetables = vegetables.slice(0, parseInt(limit));
  }
  
  const vegetablesWithOptions = vegetables.map(veg => formatVegetableWithOptions(veg));
  
  cache.set(cacheKey, {
    data: vegetablesWithOptions,
    timestamp: Date.now()
  });
  
  res.json(new ApiResponse(200, vegetablesWithOptions, "Vegetables fetched successfully"));
});

export const getVegetableById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const cacheKey = `veg:${id}`;
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(new ApiResponse(200, cached.data, "Vegetable fetched from cache"));
  }
  
  const vegetable = await Vegetable.findById(id).lean();
  
  if (!vegetable) {
    return res.status(404).json(new ApiResponse(404, null, "Vegetable not found"));
  }
  
  const vegetableWithOptions = formatVegetableWithOptions(vegetable);
  
  cache.set(cacheKey, {
    data: vegetableWithOptions,
    timestamp: Date.now()
  });
  
  res.json(new ApiResponse(200, vegetableWithOptions, "Vegetable fetched successfully"));
});

export const addVegetable = asyncHandler(async (req, res) => {
  const {
    screenNumber,
    price1kg,
    marketPrice1kg,
    offer,
    description,
    stockKg,
    image,
    name,
    setPricingEnabled,
    sets,
    stockPieces,
  } = req.body;

  if (!name) {
    return res.status(400).json(new ApiResponse(400, null, "Name is required"));
  }

  const vegetableData = {
    name,
    image,
    screenNumber,
    offer,
    description,
  };

  if (setPricingEnabled === true) {
    if (!sets || !Array.isArray(sets) || sets.length === 0) {
      return res.status(400).json(new ApiResponse(400, null, "Sets array is required for set pricing"));
    }

    if (stockPieces === undefined || isNaN(stockPieces) || parseFloat(stockPieces) < 0) {
      return res.status(400).json(new ApiResponse(400, null, "Valid stockPieces is required for set pricing"));
    }

    for (const set of sets) {
      if (set.quantity === undefined || set.price === undefined) {
        return res.status(400).json(new ApiResponse(400, null, "Each set must include quantity and price"));
      }
      if (isNaN(set.quantity) || parseFloat(set.quantity) <= 0) {
        return res.status(400).json(new ApiResponse(400, null, "Set quantity must be a positive number"));
      }
      if (isNaN(set.price) || parseFloat(set.price) <= 0) {
        return res.status(400).json(new ApiResponse(400, null, "Set price must be a positive number"));
      }
    }

    vegetableData.setPricing = {
      enabled: true,
      sets: sets.map((s) => ({
        quantity: parseFloat(s.quantity),
        unit: s.unit || "pieces",
        price: parseFloat(s.price),
        marketPrice: s.marketPrice ? parseFloat(s.marketPrice) : undefined,
        label: s.label,
      })),
    };

    vegetableData.stockPieces = parseFloat(stockPieces);
    vegetableData.outOfStock = parseFloat(stockPieces) === 0;

    vegetableData.prices = {
      weight1kg: 0,
      weight500g: 0,
      weight250g: 0,
      weight100g: 0,
    };
    vegetableData.marketPrices = {
      weight1kg: 0,
      weight500g: 0,
      weight250g: 0,
      weight100g: 0,
    };
    vegetableData.stockKg = 0;
  } else {
    if (price1kg === undefined || marketPrice1kg === undefined || stockKg === undefined) {
      return res.status(400).json(new ApiResponse(400, null, "Missing required fields: price1kg, marketPrice1kg, stockKg"));
    }

    if (isNaN(price1kg) || parseFloat(price1kg) <= 0) {
      return res.status(400).json(new ApiResponse(400, null, "VegBazar price must be a valid positive number"));
    }

    if (isNaN(marketPrice1kg) || parseFloat(marketPrice1kg) <= 0) {
      return res.status(400).json(new ApiResponse(400, null, "Market price must be a valid positive number"));
    }

    if (isNaN(stockKg) || parseFloat(stockKg) < 0) {
      return res.status(400).json(new ApiResponse(400, null, "Stock must be a valid non-negative number"));
    }

    const stockValue = parseFloat(stockKg);

    vegetableData.prices = calculatePrices(price1kg);
    vegetableData.marketPrices = calculateMarketPrices(marketPrice1kg);
    vegetableData.stockKg = stockValue;
    vegetableData.outOfStock = stockValue < 0.25;
    vegetableData.setPricing = { enabled: false, sets: [] };
    vegetableData.stockPieces = 0;
  }

  const vegetable = new Vegetable(vegetableData);
  await vegetable.save();

  cache.clear();

  res.json(new ApiResponse(201, vegetable, "Vegetable added successfully"));
});

export const deleteVegetable = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await Vegetable.findByIdAndDelete(id);
  
  if (!result) {
    return res.status(404).json(new ApiResponse(404, null, "Vegetable not found"));
  }
  
  cache.clear();
  
  res.json(new ApiResponse(200, result, "Vegetable deleted successfully"));
});

export const updateVegetable = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    price1kg,
    marketPrice1kg,
    stockKg,
    image,
    name,
    offer,
    description,
    screenNumber,
    setPricingEnabled,
    sets,
    stockPieces,
  } = req.body;

  const existingVeg = await Vegetable.findById(id);
  if (!existingVeg) {
    return res.status(404).json(new ApiResponse(404, null, "Vegetable not found"));
  }

  const updateData = {};

  if (setPricingEnabled !== undefined) {
    if (setPricingEnabled === true) {
      if (!sets || !Array.isArray(sets) || sets.length === 0) {
        return res.status(400).json(new ApiResponse(400, null, "Sets array is required when enabling set pricing"));
      }

      for (const set of sets) {
        if (!set.quantity || !set.price || parseFloat(set.quantity) <= 0 || parseFloat(set.price) <= 0) {
          return res.status(400).json(new ApiResponse(400, null, "Each set must have valid quantity and price"));
        }
      }

      updateData.setPricing = {
        enabled: true,
        sets: sets.map(s => ({
          quantity: parseFloat(s.quantity),
          unit: s.unit || "pieces",
          price: parseFloat(s.price),
          marketPrice: s.marketPrice ? parseFloat(s.marketPrice) : undefined,
          label: s.label || `${s.quantity} ${s.unit || "pieces"}`,
        })),
      };

      if (stockPieces !== undefined) {
        if (isNaN(stockPieces) || parseFloat(stockPieces) < 0) {
          return res.status(400).json(new ApiResponse(400, null, "Valid stockPieces required"));
        }
        updateData.stockPieces = parseFloat(stockPieces);
        updateData.outOfStock = parseFloat(stockPieces) === 0;
      } else {
        updateData.stockPieces = 0;
        updateData.outOfStock = true;
      }

      updateData.stockKg = 0;
    } else {
      if (price1kg !== undefined && marketPrice1kg !== undefined && stockKg !== undefined) {
        if (parseFloat(price1kg) <= 0 || parseFloat(marketPrice1kg) <= 0 || parseFloat(stockKg) < 0) {
          return res.status(400).json(new ApiResponse(400, null, "Valid price and stock required for weight pricing"));
        }

        const stockValue = parseFloat(stockKg);
        updateData.prices = calculatePrices(price1kg);
        updateData.marketPrices = calculateMarketPrices(marketPrice1kg);
        updateData.stockKg = stockValue;
        updateData.outOfStock = stockValue < 0.25;
        updateData.setPricing = { enabled: false, sets: [] };
        updateData.stockPieces = 0;
      } else {
        updateData.setPricing = { enabled: false, sets: [] };
        updateData.stockPieces = 0;
        if (existingVeg.stockKg !== undefined) {
          updateData.outOfStock = existingVeg.stockKg < 0.25;
        }
      }
    }
  } else {
    const currentMode = existingVeg.setPricing?.enabled === true;

    if (currentMode) {
      if (sets !== undefined) {
        if (!Array.isArray(sets) || sets.length === 0) {
          return res.status(400).json(new ApiResponse(400, null, "Sets array cannot be empty"));
        }

        for (const set of sets) {
          if (!set.quantity || !set.price || parseFloat(set.quantity) <= 0 || parseFloat(set.price) <= 0) {
            return res.status(400).json(new ApiResponse(400, null, "Each set must have valid quantity and price"));
          }
        }

        updateData.setPricing = {
          enabled: true,
          sets: sets.map(s => ({
            quantity: parseFloat(s.quantity),
            unit: s.unit || "pieces",
            price: parseFloat(s.price),
            marketPrice: s.marketPrice ? parseFloat(s.marketPrice) : undefined,
            label: s.label || `${s.quantity} ${s.unit || "pieces"}`,
          })),
        };
      }

      if (stockPieces !== undefined) {
        if (isNaN(stockPieces) || parseFloat(stockPieces) < 0) {
          return res.status(400).json(new ApiResponse(400, null, "Valid stockPieces required"));
        }
        updateData.stockPieces = parseFloat(stockPieces);
        updateData.outOfStock = parseFloat(stockPieces) === 0;
      }
    } else {
      if (price1kg !== undefined) {
        if (parseFloat(price1kg) <= 0) {
          return res.status(400).json(new ApiResponse(400, null, "VegBazar price must be positive"));
        }
        updateData.prices = calculatePrices(price1kg);
      }

      if (marketPrice1kg !== undefined) {
        if (parseFloat(marketPrice1kg) <= 0) {
          return res.status(400).json(new ApiResponse(400, null, "Market price must be positive"));
        }
        updateData.marketPrices = calculateMarketPrices(marketPrice1kg);
      }

      if (stockKg !== undefined) {
        if (isNaN(stockKg) || parseFloat(stockKg) < 0) {
          return res.status(400).json(new ApiResponse(400, null, "Stock must be non-negative"));
        }
        const stockValue = parseFloat(stockKg);
        updateData.stockKg = stockValue;
        updateData.outOfStock = stockValue < 0.25;
      }
    }
  }

  if (image !== undefined) updateData.image = image;
  if (name !== undefined) updateData.name = name;
  if (offer !== undefined) updateData.offer = offer;
  if (description !== undefined) updateData.description = description;
  if (screenNumber !== undefined) updateData.screenNumber = screenNumber;

  const vegetable = await Vegetable.findByIdAndUpdate(
    id,
    { $set: updateData },
    { new: true, runValidators: true }
  );

  if (!vegetable) {
    return res.status(404).json(new ApiResponse(404, null, "Vegetable not found"));
  }

  cache.clear();

  res.json(new ApiResponse(200, vegetable, "Vegetable updated successfully"));
});

export const homepageApi = asyncHandler(async (req, res) => {
  const cacheKey = 'homepage';
  const cached = cache.get(cacheKey);
   console.log(hello)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(new ApiResponse(200, cached.data, "Vegetables fetched from cache"));
  }
  
  const vegetables = await Vegetable.find({ outOfStock: false }).lean();
  const vegetablesWithOptions = vegetables.map(veg => formatVegetableWithOptions(veg));
  const shuffled = shuffleArray(vegetablesWithOptions);
  
  cache.set(cacheKey, {
    data: shuffled,
    timestamp: Date.now()
  });
  
  res.json(new ApiResponse(200, shuffled, "Vegetables fetched successfully"));
});