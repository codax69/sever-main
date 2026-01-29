import { Router } from "express";
import {
  addVegetable,
  deleteVegetable,
  updateVegetable,
  getVegetables,
  getVegetableById,
  homepageApi,
} from "../controller/vegetable.js";

import { verifyJWT, isAdmin } from "../middleware/auth.js";

const router = Router();

/* =======================
   PUBLIC ROUTES
======================= */

// Homepage API (highest priority)
router.get("/home/veg", homepageApi);

// ---------- SORT ROUTES ----------
const sortRoute = (sortBy, order = "asc") => (req, res, next) => {
  req.query.sortBy = sortBy;
  req.query.order = order;
  return getVegetables(req, res, next);
};

router.get("/sort/price-low", sortRoute("prices.weight1kg", "asc"));
router.get("/sort/price-high", sortRoute("prices.weight1kg", "desc"));
router.get("/sort/name-az", sortRoute("name", "asc"));
router.get("/sort/name-za", sortRoute("name", "desc"));
router.get("/sort/newest", sortRoute("createdAt", "desc"));
router.get("/sort/oldest", sortRoute("createdAt", "asc"));
router.get("/sort/stock-high", sortRoute("stockKg", "desc"));
router.get("/sort/stock-low", sortRoute("stockKg", "asc"));

// ---------- FILTER ROUTES ----------
const filterRoute = (filters) => (req, res, next) => {
  Object.assign(req.query, filters);
  return getVegetables(req, res, next);
};

router.get("/featured", filterRoute({ featured: "true" }));
router.get("/popular", filterRoute({ popular: "true" }));
router.get("/random", filterRoute({ random: "true" }));
router.get("/in-stock", filterRoute({ inStock: "true" }));
router.get("/out-of-stock", filterRoute({ outOfStock: "true" }));
router.get("/offers", filterRoute({ hasOffer: "true" }));

// ---------- PAGINATION ----------
router.get("/page/:page", (req, res, next) => {
  req.query.page = req.params.page;
  req.query.limit = req.query.limit || "20";
  return getVegetables(req, res, next);
});

router.get("/limit/:limit", (req, res, next) => {
  req.query.limit = req.params.limit;
  return getVegetables(req, res, next);
});


router.get(
  "/featured/sort/price-low",
  filterRoute({ featured: "true", sortBy: "prices.weight1kg", order: "asc" }),
);

router.get(
  "/popular/in-stock",
  filterRoute({ popular: "true", inStock: "true" }),
);

router.get(
  "/offers/sort/price-high",
  filterRoute({ hasOffer: "true", sortBy: "prices.weight1kg", order: "desc" }),
);


router.get("/", getVegetables);


router.get("/:id", getVegetableById);



router.post("/add", verifyJWT, isAdmin, addVegetable);
router.put("/:id", verifyJWT, isAdmin, updateVegetable);
router.patch("/:id", verifyJWT, isAdmin, updateVegetable);
router.delete("/:id", verifyJWT, isAdmin, deleteVegetable);

export default router;
