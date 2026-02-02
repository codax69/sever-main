import Basket from "../Model/basket.js";
import Order from "../Model/order.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";

// Helper function to calculate value score (quality to price ratio)
const calculateValueScore = (basket) => {
  const itemCount = basket.items?.length || 0;
  const totalPrice = basket.totalPrice || basket.price || 0;

  if (totalPrice === 0) return 0;

  // Value score: more items per rupee = better value
  // Also consider discount percentage if available
  const discountFactor = basket.discount ? 1 + basket.discount / 100 : 1;
  return (itemCount / totalPrice) * 100 * discountFactor;
};

// Get Most Selling baskets
export const getMostSellingBaskets = asyncHandler(async (req, res) => {
  const { limit = 10, category } = req.query;

  try {
    // Build match criteria
    const matchCriteria = { isActive: true };
    if (category) {
      matchCriteria.category = category;
    }

    // Aggregate baskets with their order counts
    const mostSellingBaskets = await Order.aggregate([
      { $unwind: "$items" },
      { $match: { "items.itemType": "basket" } }, // Modified to check for basket
      {
        $group: {
          _id: "$items.itemId",
          totalOrders: { $sum: 1 },
          totalQuantity: { $sum: "$items.quantity" },
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: parseInt(limit) },
      {
        $lookup: {
          from: "baskets", // Modified collection name
          localField: "_id",
          foreignField: "_id",
          as: "basketDetails", // Modified alias
        },
      },
      { $unwind: "$basketDetails" },
      { $match: matchCriteria },
      {
        $project: {
          _id: "$basketDetails._id",
          name: "$basketDetails.name",
          description: "$basketDetails.description",
          price: "$basketDetails.price",
          totalPrice: "$basketDetails.totalPrice",
          discount: "$basketDetails.discount",
          image: "$basketDetails.image",
          items: "$basketDetails.items",
          category: "$basketDetails.category",
          totalOrders: 1,
          totalQuantity: 1,
          tag: { $literal: "Most Selling" },
        },
      },
    ]);

    // If no orders found, get popular baskets by other metrics
    if (mostSellingBaskets.length === 0) {
      const fallbackBaskets = await Basket.find(matchCriteria)
        .sort({ views: -1, createdAt: -1 })
        .limit(parseInt(limit))
        .select("-__v");

      return res.json(
        new ApiResponse(
          200,
          fallbackBaskets.map((basket) => ({
            ...basket.toObject(),
            tag: "Popular",
          })),
          "Popular baskets fetched successfully",
        ),
      );
    }

    res.json(
      new ApiResponse(
        200,
        mostSellingBaskets,
        "Most selling baskets fetched successfully",
      ),
    );
  } catch (error) {
    console.error("Error fetching most selling baskets:", error);
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Failed to fetch most selling baskets"));
  }
});

// Get Premium baskets
export const getPremiumBaskets = asyncHandler(async (req, res) => {
  const { limit = 10, minPrice, category } = req.query;

  try {
    const matchCriteria = { isActive: true };

    if (category) {
      matchCriteria.category = category;
    }

    // Premium baskets are high-priced, quality baskets
    if (minPrice) {
      matchCriteria.$or = [
        { price: { $gte: parseFloat(minPrice) } },
        { totalPrice: { $gte: parseFloat(minPrice) } },
      ];
    } else {
      // Default minimum for premium: 500 rupees
      matchCriteria.$or = [
        { price: { $gte: 500 } },
        { totalPrice: { $gte: 500 } },
      ];
    }

    const premiumBaskets = await Basket.find(matchCriteria)
      .sort({ totalPrice: -1, price: -1, rating: -1 })
      .limit(parseInt(limit))
      .select("-__v");

    const basketsWithTag = premiumBaskets.map((basket) => ({
      ...basket.toObject(),
      tag: "Premium",
      isPremium: true,
    }));

    res.json(
      new ApiResponse(
        200,
        basketsWithTag,
        "Premium baskets fetched successfully",
      ),
    );
  } catch (error) {
    console.error("Error fetching premium baskets:", error);
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Failed to fetch premium baskets"));
  }
});

// Get Best Value baskets
export const getBestValueBaskets = asyncHandler(async (req, res) => {
  const { limit = 10, maxPrice, category } = req.query;

  try {
    const matchCriteria = { isActive: true };

    if (category) {
      matchCriteria.category = category;
    }

    if (maxPrice) {
      matchCriteria.$or = [
        { price: { $lte: parseFloat(maxPrice) } },
        { totalPrice: { $lte: parseFloat(maxPrice) } },
      ];
    }

    const allBaskets = await Basket.find(matchCriteria).select("-__v");

    // Calculate value score for each basket
    const basketsWithValue = allBaskets.map((basket) => ({
      ...basket.toObject(),
      valueScore: calculateValueScore(basket.toObject()),
      tag: "Best Value",
      isBestValue: true,
    }));

    // Sort by value score descending
    basketsWithValue.sort((a, b) => b.valueScore - a.valueScore);

    // Get top baskets
    const bestValueBaskets = basketsWithValue.slice(0, parseInt(limit));

    res.json(
      new ApiResponse(
        200,
        bestValueBaskets,
        "Best value baskets fetched successfully",
      ),
    );
  } catch (error) {
    console.error("Error fetching best value baskets:", error);
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Failed to fetch best value baskets"));
  }
});

// Get All Recommendations (Combined)
export const getAllRecommendations = asyncHandler(async (req, res) => {
  const { category, limit = 5 } = req.query;
  const limitNum = parseInt(limit);

  try {
    // Fetch all recommendations in parallel
    const [mostSellingResult, premiumResult, bestValueResult] =
      await Promise.allSettled([
        getMostSellingBasketsInternal(limitNum, category),
        getPremiumBasketsInternal(limitNum, category),
        getBestValueBasketsInternal(limitNum, category),
      ]);

    const recommendations = {
      mostSelling:
        mostSellingResult.status === "fulfilled" ? mostSellingResult.value : [],
      premium: premiumResult.status === "fulfilled" ? premiumResult.value : [],
      bestValue:
        bestValueResult.status === "fulfilled" ? bestValueResult.value : [],
    };

    res.json(
      new ApiResponse(
        200,
        recommendations,
        "All basket recommendations fetched successfully",
      ),
    );
  } catch (error) {
    console.error("Error fetching all recommendations:", error);
    return res
      .status(500)
      .json(
        new ApiResponse(500, null, "Failed to fetch basket recommendations"),
      );
  }
});

// Internal helper functions (no response, just return data)
const getMostSellingBasketsInternal = async (limit, category) => {
  const matchCriteria = { isActive: true };
  if (category) matchCriteria.category = category;

  const baskets = await Order.aggregate([
    { $unwind: "$items" },
    { $match: { "items.itemType": "basket" } },
    {
      $group: {
        _id: "$items.itemId",
        totalQuantity: { $sum: "$items.quantity" },
      },
    },
    { $sort: { totalQuantity: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "baskets",
        localField: "_id",
        foreignField: "_id",
        as: "basketDetails",
      },
    },
    { $unwind: "$basketDetails" },
    { $match: matchCriteria },
    {
      $project: {
        _id: "$basketDetails._id",
        name: "$basketDetails.name",
        price: "$basketDetails.price",
        totalPrice: "$basketDetails.totalPrice",
        image: "$basketDetails.image",
        items: "$basketDetails.items",
        totalQuantity: 1,
        tag: { $literal: "Most Selling" },
      },
    },
  ]);

  if (baskets.length === 0) {
    const fallback = await Basket.find(matchCriteria)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("name price totalPrice image items");
    return fallback.map((b) => ({ ...b.toObject(), tag: "Popular" }));
  }

  return baskets;
};

const getPremiumBasketsInternal = async (limit, category) => {
  const matchCriteria = { isActive: true };
  if (category) matchCriteria.category = category;
  matchCriteria.$or = [{ price: { $gte: 500 } }, { totalPrice: { $gte: 500 } }];

  const baskets = await Basket.find(matchCriteria)
    .sort({ totalPrice: -1, price: -1 })
    .limit(limit)
    .select("name price totalPrice image items");

  return baskets.map((b) => ({ ...b.toObject(), tag: "Premium" }));
};

const getBestValueBasketsInternal = async (limit, category) => {
  const matchCriteria = { isActive: true };
  if (category) matchCriteria.category = category;

  const baskets = await Basket.find(matchCriteria).select(
    "name price totalPrice image items discount",
  );

  const withScores = baskets.map((b) => ({
    ...b.toObject(),
    valueScore: calculateValueScore(b.toObject()),
    tag: "Best Value",
  }));

  withScores.sort((a, b) => b.valueScore - a.valueScore);
  return withScores.slice(0, limit);
};
