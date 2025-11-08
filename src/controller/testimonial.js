import Testimonial from "../Model/testimonial.js";
import { ApiError } from "../utility/ApiError.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";

// Create testimonial
export const createTestimonial = asyncHandler(async (req, res) => {
  const { name, email, rating, comment } = req.body;
//  console.log({name, email, rating, comment})
  if (!name || !email || !rating || !comment)
    throw new ApiError(400, "All fields are required");

  if (rating < 1 || rating > 5)
    throw new ApiError(400, "Rating must be between 1 and 5");

  if (comment.length < 10)
    throw new ApiError(400, "Comment must be at least 10 characters long");

  if (comment.length > 500)
    throw new ApiError(400, "Comment cannot exceed 500 characters");

  const testimonial = await Testimonial.create({
    name,
    email,
    rating,
    comment,
  });

  return res
    .status(201)
    .json(
      new ApiResponse(
        201,
        testimonial,
        "Thank you for your feedback! It will be reviewed and published soon."
      )
    );
});

// Public: Get published testimonials
export const getPublishedTestimonials = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, rating } = req.query;
  const query = { isApproved: true, isPublished: true };

  if (rating) query.rating = parseInt(rating);

  const testimonials = await Testimonial.find(query)
    .select("-email -isApproved -isPublished")
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .lean();

  const count = await Testimonial.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(200, {
      testimonials,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      total: count,
    })
  );
});

// Admin: Get all testimonials
export const getAllTestimonials = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, isApproved, isPublished } = req.query;
  const query = {};

  if (isApproved !== undefined) query.isApproved = isApproved === "true";
  if (isPublished !== undefined) query.isPublished = isPublished === "true";

  const testimonials = await Testimonial.find(query)
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .lean();

  const count = await Testimonial.countDocuments(query);

  return res.status(200).json(
    new ApiResponse(200, {
      testimonials,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      total: count,
    })
  );
});

// Admin: Get by ID
export const getTestimonialById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const testimonial = await Testimonial.findById(id);

  if (!testimonial) throw new ApiError(404, "Testimonial not found");

  return res.status(200).json(new ApiResponse(200, testimonial));
});

// Admin: Update testimonial
export const updateTestimonial = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { isApproved, isPublished } = req.body;

  const testimonial = await Testimonial.findById(id);
  if (!testimonial) throw new ApiError(404, "Testimonial not found");

  if (isApproved !== undefined) testimonial.isApproved = isApproved;
  if (isPublished !== undefined) testimonial.isPublished = isPublished;

  await testimonial.save();

  return res
    .status(200)
    .json(
      new ApiResponse(200, testimonial, "Testimonial updated successfully")
    );
});

// Admin: Delete testimonial
export const deleteTestimonial = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const testimonial = await Testimonial.findByIdAndDelete(id);

  if (!testimonial) throw new ApiError(404, "Testimonial not found");

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Testimonial deleted successfully"));
});

// Admin: Get stats
export const getTestimonialStats = asyncHandler(async (req, res) => {
  const stats = await Testimonial.aggregate([
    {
      $group: {
        _id: null,
        totalTestimonials: { $sum: 1 },
        approvedTestimonials: { $sum: { $cond: ["$isApproved", 1, 0] } },
        publishedTestimonials: { $sum: { $cond: ["$isPublished", 1, 0] } },
        averageRating: { $avg: "$rating" },
      },
    },
  ]);

  const ratingDistribution = await Testimonial.aggregate([
    { $group: { _id: "$rating", count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ]);

  return res.status(200).json(
    new ApiResponse(200, {
      stats: stats[0] || {},
      ratingDistribution,
    })
  );
});
