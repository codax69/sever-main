import { Router } from "express";
import {
  addVegetable,
  deleteVegetable,
  updateVegetable,
  getVegetables,
  getVegetableById,
  homepageApi
} from "../controller/vegetable.js";
import adminMiddleware from "../middleware/admin.js";

const router = Router();

// Homepage API - highest priority, separate endpoint
router.get("/home/veg", homepageApi);


router.get("/sort/price-low", (req, res, next) => {
  req.query.sortBy = 'prices.weight1kg';
  req.query.order = 'asc';
  getVegetables(req, res, next);
});

router.get("/sort/price-high", (req, res, next) => {
  req.query.sortBy = 'prices.weight1kg';
  req.query.order = 'desc';
  getVegetables(req, res, next);
});

router.get("/sort/name-az", (req, res, next) => {
  req.query.sortBy = 'name';
  req.query.order = 'asc';
  getVegetables(req, res, next);
});

router.get("/sort/name-za", (req, res, next) => {
  req.query.sortBy = 'name';
  req.query.order = 'desc';
  getVegetables(req, res, next);
});

router.get("/sort/newest", (req, res, next) => {
  req.query.sortBy = 'createdAt';
  req.query.order = 'desc';
  getVegetables(req, res, next);
});

router.get("/sort/oldest", (req, res, next) => {
  req.query.sortBy = 'createdAt';
  req.query.order = 'asc';
  getVegetables(req, res, next);
});

router.get("/sort/stock-high", (req, res, next) => {
  req.query.sortBy = 'stockKg';
  req.query.order = 'desc';
  getVegetables(req, res, next);
});

router.get("/sort/stock-low", (req, res, next) => {
  req.query.sortBy = 'stockKg';
  req.query.order = 'asc';
  getVegetables(req, res, next);
});

// Filter routes
router.get("/featured", (req, res, next) => {
  req.query.featured = 'true';
  getVegetables(req, res, next);
});

router.get("/popular", (req, res, next) => {
  req.query.popular = 'true';
  getVegetables(req, res, next);
});

router.get("/random", (req, res, next) => {
  req.query.random = 'true';
  getVegetables(req, res, next);
});

router.get("/in-stock", (req, res, next) => {
  req.query.inStock = 'true';
  getVegetables(req, res, next);
});

router.get("/out-of-stock", (req, res, next) => {
  req.query.outOfStock = 'true';
  getVegetables(req, res, next);
});

router.get("/offers", (req, res, next) => {
  req.query.hasOffer = 'true';
  getVegetables(req, res, next);
});

// Pagination routes
router.get("/page/:page", (req, res, next) => {
  req.query.page = req.params.page;
  req.query.limit = req.query.limit || '20';
  getVegetables(req, res, next);
});

// Limit routes
router.get("/limit/:limit", (req, res, next) => {
  req.query.limit = req.params.limit;
  getVegetables(req, res, next);
});

// Combined filters (can be chained)
router.get("/featured/sort/price-low", (req, res, next) => {
  req.query.featured = 'true';
  req.query.sortBy = 'prices.weight1kg';
  req.query.order = 'asc';
  getVegetables(req, res, next);
});

router.get("/popular/in-stock", (req, res, next) => {
  req.query.popular = 'true';
  req.query.inStock = 'true';
  getVegetables(req, res, next);
});

router.get("/offers/sort/price-high", (req, res, next) => {
  req.query.hasOffer = 'true';
  req.query.sortBy = 'prices.weight1kg';
  req.query.order = 'desc';
  getVegetables(req, res, next);
});

// Default get all vegetables (supports query params)
router.get("/", getVegetables);

// Get single vegetable by ID (must be after all specific routes)
router.get("/:id", getVegetableById);

// Admin routes - protected
router.post("/add", adminMiddleware, addVegetable);
router.put("/:id", adminMiddleware, updateVegetable);
router.patch("/:id", adminMiddleware, updateVegetable);
router.delete("/:id", adminMiddleware, deleteVegetable);

export default router;