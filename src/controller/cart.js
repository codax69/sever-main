import Cart from "../Model/cart.js";
import Vegetable from "../Model/vegetable.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";

// ============= ADVANCED DSA IMPLEMENTATIONS FOR CART =============

// LRU Cache for cart data (max 200 carts)
class CartLRUCache {
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size();
  }
}

// Priority Queue for cart item sorting
class CartPriorityQueue {
  constructor() {
    this.heap = [];
  }

  enqueue(item, priority) {
    const element = { item, priority };
    this.heap.push(element);
    this._bubbleUp(this.heap.length - 1);
  }

  dequeue() {
    if (this.isEmpty()) return null;
    const root = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return root;
  }

  peek() {
    return this.isEmpty() ? null : this.heap[0];
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[parentIndex].priority <= this.heap[index].priority) break;
      [this.heap[parentIndex], this.heap[index]] = [this.heap[index], this.heap[parentIndex]];
      index = parentIndex;
    }
  }

  _sinkDown(index) {
    const length = this.heap.length;
    while (true) {
      let left = 2 * index + 1;
      let right = 2 * index + 2;
      let smallest = index;

      if (left < length && this.heap[left].priority < this.heap[smallest].priority) {
        smallest = left;
      }
      if (right < length && this.heap[right].priority < this.heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === index) break;

      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
}

// Bloom Filter for duplicate item detection
class CartBloomFilter {
  constructor(size = 10000, hashCount = 4) {
    this.size = size;
    this.hashCount = hashCount;
    this.bitArray = new Array(size).fill(false);
  }

  _hash(value, seed) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash + value.charCodeAt(i) + seed) & 0xffffffff;
    }
    return Math.abs(hash) % this.size;
  }

  add(value) {
    for (let i = 0; i < this.hashCount; i++) {
      const index = this._hash(value, i);
      this.bitArray[index] = true;
    }
  }

  mightContain(value) {
    for (let i = 0; i < this.hashCount; i++) {
      const index = this._hash(value, i);
      if (!this.bitArray[index]) return false;
    }
    return true;
  }
}

// Hash Map for product recommendations
class ProductRecommendationGraph {
  constructor() {
    this.adjacencyList = new Map(); // productId -> Set of related products
    this.purchaseFrequency = new Map(); // product pair -> frequency
  }

  addPurchase(products) {
    // Create connections between all products in the purchase
    for (let i = 0; i < products.length; i++) {
      const productId = products[i];

      if (!this.adjacencyList.has(productId)) {
        this.adjacencyList.set(productId, new Set());
      }

      for (let j = 0; j < products.length; j++) {
        if (i !== j) {
          const relatedProductId = products[j];
          this.adjacencyList.get(productId).add(relatedProductId);

          // Track frequency
          const pairKey = [productId, relatedProductId].sort().join('-');
          this.purchaseFrequency.set(pairKey, (this.purchaseFrequency.get(pairKey) || 0) + 1);
        }
      }
    }
  }

  getRecommendations(productId, limit = 5) {
    const related = this.adjacencyList.get(productId);
    if (!related) return [];

    // Sort by frequency
    const recommendations = Array.from(related)
      .map(relatedId => ({
        productId: relatedId,
        frequency: this.purchaseFrequency.get([productId, relatedId].sort().join('-')) || 1
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit);

    return recommendations;
  }
}

// ============= GLOBAL DSA INSTANCES =============

// LRU Cache for cart data
const cartCache = new CartLRUCache(200);

// Bloom Filter for duplicate cart items
const cartItemBloomFilter = new CartBloomFilter(50000, 5);

// Product recommendation graph
const recommendationGraph = new ProductRecommendationGraph();

// Hash Map for user cart tracking
const userCartMap = new Map(); // userId -> cartId

// Set for active cart sessions
const activeCartSessions = new Set();

// ============= CART CONTROLLER FUNCTIONS =============

// Get user's cart with DSA optimizations
export const getCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { sortBy = "addedAt", sortOrder = "desc" } = req.query;

  // Check cache first
  const cacheKey = `cart_${userId}`;
  let cart = cartCache.get(cacheKey);

  if (!cart) {
    cart = await Cart.getOrCreateCart(userId);
    cartCache.set(cacheKey, cart);
  }

  // Populate product details
  await cart.populate({
    path: "items.product",
    select: "name image category isAvailable",
  });

  // Sort items using Priority Queue
  const pq = new CartPriorityQueue();
  cart.items.forEach((item, index) => {
    let priority = 0;
    switch (sortBy) {
      case "price":
        priority = item.price;
        break;
      case "quantity":
        priority = item.quantity;
        break;
      case "totalPrice":
        priority = item.totalPrice;
        break;
      case "addedAt":
      default:
        priority = new Date(item.addedAt).getTime();
        break;
    }
    pq.enqueue({ ...item.toObject(), originalIndex: index }, sortOrder === "desc" ? -priority : priority);
  });

  // Extract sorted items
  const sortedItems = [];
  while (!pq.isEmpty()) {
    sortedItems.push(pq.dequeue().item);
  }

  // Replace items with sorted version
  cart.items = sortedItems;

  res.status(200).json(
    new ApiResponse(200, {
      cart: {
        ...cart.toObject(),
        items: sortedItems,
      },
      cacheStats: {
        cacheSize: cartCache.size(),
        isCached: cartCache.get(cacheKey) !== null,
      },
    }, "Cart retrieved successfully")
  );
});

// Add item to cart with DSA optimizations
export const addToCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId, quantity, weight } = req.body;

  // Validate input
  if (!productId || !quantity || !weight) {
    throw new ApiError(400, "Product ID, quantity, and weight are required");
  }

  if (quantity < 1 || quantity > 99) {
    throw new ApiError(400, "Quantity must be between 1 and 99");
  }

  // Check if product exists and is available
  const product = await Vegetable.findById(productId);
  if (!product) {
    throw new ApiError(404, "Product not found");
  }

  if (!product.isAvailable) {
    throw new ApiError(400, "Product is not available");
  }

  // Get price for selected weight
  const weightPriceMap = {
    "1kg": product.weight1kg,
    "500g": product.weight500g,
    "250g": product.weight250g,
    "100g": product.weight100g,
  };

  const selectedWeightPrice = weightPriceMap[weight];
  if (!selectedWeightPrice) {
    throw new ApiError(400, "Invalid weight selection");
  }

  // Check for duplicates using Bloom Filter
  const itemSignature = `${userId}-${productId}-${weight}`;
  if (cartItemBloomFilter.mightContain(itemSignature)) {
    // Verify with database
    const cart = await Cart.findOne({ user: userId, status: "active" });
    if (cart) {
      const existingItem = cart.items.find(
        item => item.product.toString() === productId && item.weight === weight
      );
      if (existingItem) {
        throw new ApiError(409, "Item already exists in cart. Use update quantity instead.");
      }
    }
  }

  // Get or create cart
  const cart = await Cart.getOrCreateCart(userId);

  // Add item using model method
  await cart.addItem(productId, quantity, selectedWeightPrice, weight, getWeightInGrams(weight));

  // Update DSA structures
  cartItemBloomFilter.add(itemSignature);
  activeCartSessions.add(userId);
  userCartMap.set(userId, cart._id.toString());

  // Update recommendation graph
  const currentProductIds = cart.items.map(item => item.product.toString());
  recommendationGraph.addPurchase(currentProductIds);

  // Update cache
  cartCache.set(`cart_${userId}`, cart);

  res.status(201).json(
    new ApiResponse(201, {
      cart: cart.toObject(),
      addedItem: {
        product: productId,
        quantity,
        weight,
        price: selectedWeightPrice,
      },
    }, "Item added to cart successfully")
  );
});

// Update cart item quantity
export const updateCartItem = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId, weight, quantity } = req.body;

  if (!productId || !weight || quantity === undefined) {
    throw new ApiError(400, "Product ID, weight, and quantity are required");
  }

  if (quantity < 0 || quantity > 99) {
    throw new ApiError(400, "Quantity must be between 0 and 99");
  }

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) {
    throw new ApiError(404, "Cart not found");
  }

  if (quantity === 0) {
    // Remove item
    await cart.removeItem(productId, weight);
  } else {
    // Update quantity
    await cart.updateItemQuantity(productId, weight, quantity);
  }

  // Update cache
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
      updatedItem: {
        product: productId,
        weight,
        quantity,
      },
    }, "Cart item updated successfully")
  );
});

// Remove item from cart
export const removeFromCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId, weight } = req.body;

  if (!productId || !weight) {
    throw new ApiError(400, "Product ID and weight are required");
  }

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) {
    throw new ApiError(404, "Cart not found");
  }

  await cart.removeItem(productId, weight);

  // Update cache
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
    }, "Item removed from cart successfully")
  );
});

// Clear entire cart
export const clearCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) {
    throw new ApiError(404, "Cart not found");
  }

  await cart.clearCart();

  // Clear cache and update DSA structures
  cartCache.delete(`cart_${userId}`);
  activeCartSessions.delete(userId);
  userCartMap.delete(userId);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
    }, "Cart cleared successfully")
  );
});

// Apply coupon to cart
export const applyCoupon = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { couponId, discountAmount } = req.body;

  if (!couponId || discountAmount === undefined) {
    throw new ApiError(400, "Coupon ID and discount amount are required");
  }

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) {
    throw new ApiError(404, "Cart not found");
  }

  await cart.applyCoupon(couponId, discountAmount);

  // Update cache
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
      appliedCoupon: {
        couponId,
        discountAmount,
      },
    }, "Coupon applied successfully")
  );
});

// Remove coupon from cart
export const removeCoupon = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) {
    throw new ApiError(404, "Cart not found");
  }

  await cart.removeCoupon();

  // Update cache
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
    }, "Coupon removed successfully")
  );
});

// Get cart recommendations
export const getCartRecommendations = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { limit = 5 } = req.query;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart || cart.items.length === 0) {
    return res.status(200).json(
      new ApiResponse(200, {
        recommendations: [],
      }, "No recommendations available")
    );
  }

  // Get recommendations based on cart items
  const cartProductIds = cart.items.map(item => item.product.toString());
  const allRecommendations = new Map();

  cartProductIds.forEach(productId => {
    const recs = recommendationGraph.getRecommendations(productId, limit);
    recs.forEach(rec => {
      if (!cartProductIds.includes(rec.productId)) {
        allRecommendations.set(rec.productId, rec);
      }
    });
  });

  // Get top recommendations
  const recommendations = Array.from(allRecommendations.values())
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit);

  // Populate product details
  const productIds = recommendations.map(r => r.productId);
  const products = await Vegetable.find({ _id: { $in: productIds } })
    .select("name image price category")
    .limit(limit);

  const recommendationsWithProducts = recommendations.map(rec => ({
    ...rec,
    product: products.find(p => p._id.toString() === rec.productId),
  })).filter(rec => rec.product);

  res.status(200).json(
    new ApiResponse(200, {
      recommendations: recommendationsWithProducts,
      basedOn: cartProductIds.length,
      algorithm: "Collaborative Filtering",
    }, "Cart recommendations retrieved successfully")
  );
});

// Get cart analytics
export const getCartAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) {
    throw new ApiError(404, "Cart not found");
  }

  // Calculate analytics using DSA
  const analytics = {
    itemCount: cart.items.length,
    totalQuantity: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    averageItemPrice: cart.averageItemPrice,
    totalValue: cart.totalValue,
    priceDistribution: {},
    categoryDistribution: {},
    weightDistribution: {},
  };

  // Analyze distributions
  cart.items.forEach(item => {
    // Price ranges
    const priceRange = Math.floor(item.price / 50) * 50;
    analytics.priceDistribution[`₹${priceRange}-₹${priceRange + 49}`] =
      (analytics.priceDistribution[`₹${priceRange}-₹${priceRange + 49}`] || 0) + 1;

    // Weight distribution
    analytics.weightDistribution[item.weight] =
      (analytics.weightDistribution[item.weight] || 0) + 1;
  });

  res.status(200).json(
    new ApiResponse(200, {
      analytics,
      dsaPerformance: {
        cacheSize: cartCache.size(),
        bloomFilterSize: cartItemBloomFilter.size,
        activeSessions: activeCartSessions.size,
        recommendationGraphNodes: recommendationGraph.adjacencyList.size,
      },
    }, "Cart analytics retrieved successfully")
  );
});

// Merge guest cart (for future use)
export const mergeGuestCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { guestCartItems } = req.body;

  if (!guestCartItems || !Array.isArray(guestCartItems)) {
    throw new ApiError(400, "Guest cart items are required");
  }

  const cart = await Cart.getOrCreateCart(userId);

  // Merge items efficiently
  for (const guestItem of guestCartItems) {
    const existingItem = cart.items.find(
      item => item.product.toString() === guestItem.product &&
             item.weight === guestItem.weight
    );

    if (existingItem) {
      existingItem.quantity += guestItem.quantity;
      existingItem.totalPrice = existingItem.quantity * existingItem.price;
    } else {
      cart.items.push(guestItem);
    }
  }

  await cart.save();

  // Update cache
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
      mergedItems: guestCartItems.length,
    }, "Guest cart merged successfully")
  );
});

// ============= UTILITY FUNCTIONS =============

function getWeightInGrams(weight) {
  const weightMap = {
    "1kg": 1000,
    "500g": 500,
    "250g": 250,
    "100g": 100,
  };
  return weightMap[weight] || 0;
}