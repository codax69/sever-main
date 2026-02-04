import offer from "../Model/offer.js";
import Order from "../Model/order.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";

// Helper function to calculate value score (quality to price ratio)
const calculateValueScore = (offer) => {
  const itemCount = offer.items?.length || 0;
  const totalPrice = offer.totalPrice || offer.price || 0;

  if (totalPrice === 0) return 0;

  // Value score: more items per rupee = better value
  // Also consider discount percentage if available
  const discountFactor = offer.discount ? 1 + offer.discount / 100 : 1;
  return (itemCount / totalPrice) * 100 * discountFactor;
};

// Get Most Selling offers
export const getMostSellingOffers = asyncHandler(async (req, res) => {
  const { limit = 10, category } = req.query;

  try {
    // Build match criteria
    const matchCriteria = { isActive: true };
    if (category) {
      matchCriteria.category = category;
    }

    // Aggregate offers with their order counts
    const mostSellingOffers = await Order.aggregate([
      { $unwind: "$items" },
      { $match: { "items.itemType": "offer" } },
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
          from: "offers",
          localField: "_id",
          foreignField: "_id",
          as: "offerDetails",
        },
      },
      { $unwind: "$offerDetails" },
      { $match: matchCriteria },
      {
        $project: {
          _id: "$offerDetails._id",
          name: "$offerDetails.name",
          description: "$offerDetails.description",
          price: "$offerDetails.price",
          totalPrice: "$offerDetails.totalPrice",
          discount: "$offerDetails.discount",
          image: "$offerDetails.image",
          items: "$offerDetails.items",
          category: "$offerDetails.category",
          totalOrders: 1,
          totalQuantity: 1,
          tag: { $literal: "Most Selling" },
        },
      },
    ]);

    // If no orders found, get popular offers by other metrics
    if (mostSellingOffers.length === 0) {
      const fallbackOffers = await offer
        .find(matchCriteria)
        .sort({ views: -1, createdAt: -1 })
        .limit(parseInt(limit))
        .select("-__v");

      return res.json(
        new ApiResponse(
          200,
          fallbackOffers.map((offer) => ({
            ...offer.toObject(),
            tag: "Popular",
          })),
          "Popular offers fetched successfully"
        )
      );
    }

    res.json(
      new ApiResponse(
        200,
        mostSellingOffers,
        "Most selling offers fetched successfully"
      )
    );
  } catch (error) {
    console.error("Error fetching most selling offers:", error);
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Failed to fetch most selling offers"));
  }
});

// Get Premium offers
export const getPremiumOffers = asyncHandler(async (req, res) => {
  const { limit = 10, minPrice, category } = req.query;

  try {
    const matchCriteria = { isActive: true };

    if (category) {
      matchCriteria.category = category;
    }

    // Premium offers are high-priced, quality offers
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

    const premiumOffers = await offer
      .find(matchCriteria)
      .sort({ totalPrice: -1, price: -1, rating: -1 })
      .limit(parseInt(limit))
      .select("-__v");

    const offersWithTag = premiumOffers.map((offer) => ({
      ...offer.toObject(),
      tag: "Premium",
      isPremium: true,
    }));

    res.json(
      new ApiResponse(200, offersWithTag, "Premium offers fetched successfully")
    );
  } catch (error) {
    console.error("Error fetching premium offers:", error);
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Failed to fetch premium offers"));
  }
});

// Get Best Value offers
export const getBestValueoffers = asyncHandler(async (req, res) => {
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

    const alloffers = await offer.find(matchCriteria).select("-__v");

    // Calculate value score for each offer
    const offersWithValue = alloffers.map((offer) => ({
      ...offer.toObject(),
      valueScore: calculateValueScore(offer.toObject()),
      tag: "Best Value",
      isBestValue: true,
    }));

    // Sort by value score descending
    offersWithValue.sort((a, b) => b.valueScore - a.valueScore);

    // Get top offers
    const bestValueoffers = offersWithValue.slice(0, parseInt(limit));

    res.json(
      new ApiResponse(
        200,
        bestValueoffers,
        "Best value offers fetched successfully"
      )
    );
  } catch (error) {
    console.error("Error fetching best value offers:", error);
    return res
      .status(500)
      .json(new ApiResponse(500, null, "Failed to fetch best value offers"));
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
        getMostSellingoffersInternal(limitNum, category),
        getPremiumoffersInternal(limitNum, category),
        getBestValueoffersInternal(limitNum, category),
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
        "All offer recommendations fetched successfully"
      )
    );
  } catch (error) {
    console.error("Error fetching all recommendations:", error);
    return res
      .status(500)
      .json(
        new ApiResponse(500, null, "Failed to fetch offer recommendations")
      );
  }
});

// Internal helper functions (no response, just return data)
const getMostSellingoffersInternal = async (limit, category) => {
  const matchCriteria = { isActive: true };
  if (category) matchCriteria.category = category;

  const offers = await Order.aggregate([
    { $unwind: "$items" },
    { $match: { "items.itemType": "offer" } },
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
        from: "offers",
        localField: "_id",
        foreignField: "_id",
        as: "offerDetails",
      },
    },
    { $unwind: "$offerDetails" },
    { $match: matchCriteria },
    {
      $project: {
        _id: "$offerDetails._id",
        name: "$offerDetails.name",
        price: "$offerDetails.price",
        totalPrice: "$offerDetails.totalPrice",
        image: "$offerDetails.image",
        items: "$offerDetails.items",
        totalQuantity: 1,
        tag: { $literal: "Most Selling" },
      },
    },
  ]);

  if (offers.length === 0) {
    const fallback = await offer
      .find(matchCriteria)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("name price totalPrice image items");
    return fallback.map((b) => ({ ...b.toObject(), tag: "Popular" }));
  }

  return offers;
};

const getPremiumOffersInternal = async (limit, category) => {
  const matchCriteria = { isActive: true };
  if (category) matchCriteria.category = category;
  matchCriteria.$or = [{ price: { $gte: 500 } }, { totalPrice: { $gte: 500 } }];

  const offers = await offer
    .find(matchCriteria)
    .sort({ totalPrice: -1, price: -1 })
    .limit(limit)
    .select("name price totalPrice image items");

  return offers.map((b) => ({ ...b.toObject(), tag: "Premium" }));
};

const getBestValueOffersInternal = async (limit, category) => {
  const matchCriteria = { isActive: true };
  if (category) matchCriteria.category = category;

  const offers = await offer
    .find(matchCriteria)
    .select("name price totalPrice image items discount");

  const withScores = offers.map((b) => ({
    ...b.toObject(),
    valueScore: calculateValueScore(b.toObject()),
    tag: "Best Value",
  }));

  withScores.sort((a, b) => b.valueScore - a.valueScore);
  return withScores.slice(0, limit);
};
