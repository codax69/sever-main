import Cart from "../Model/cart.js";
import Vegetable from "../Model/vegetable.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";

// ─── LRU Cache ────────────────────────────────────────────────────────────────
class CartLRUCache {
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
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

  // ✅ size is a getter (Map.size is a property, NOT a method — never call it as size())
  get size() {
    return this.cache.size;
  }
}

// ─── Priority Queue ───────────────────────────────────────────────────────────
class CartPriorityQueue {
  constructor() {
    this.heap = [];
  }

  enqueue(item, priority) {
    this.heap.push({ item, priority });
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
      if (left < length && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < length && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === index) break;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
}

// ─── Bloom Filter ─────────────────────────────────────────────────────────────
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
      this.bitArray[this._hash(value, i)] = true;
    }
  }

  mightContain(value) {
    for (let i = 0; i < this.hashCount; i++) {
      if (!this.bitArray[this._hash(value, i)]) return false;
    }
    return true;
  }
}

// ─── Product Recommendation Graph ────────────────────────────────────────────
class ProductRecommendationGraph {
  constructor() {
    this.adjacencyList = new Map();
    this.purchaseFrequency = new Map();
  }

  addPurchase(products) {
    for (let i = 0; i < products.length; i++) {
      const productId = products[i];
      if (!this.adjacencyList.has(productId)) {
        this.adjacencyList.set(productId, new Set());
      }
      for (let j = 0; j < products.length; j++) {
        if (i !== j) {
          const relatedId = products[j];
          this.adjacencyList.get(productId).add(relatedId);
          const pairKey = [productId, relatedId].sort().join("-");
          this.purchaseFrequency.set(pairKey, (this.purchaseFrequency.get(pairKey) || 0) + 1);
        }
      }
    }
  }

  getRecommendations(productId, limit = 5) {
    const related = this.adjacencyList.get(productId);
    if (!related) return [];
    return Array.from(related)
      .map((relatedId) => ({
        productId: relatedId,
        frequency: this.purchaseFrequency.get([productId, relatedId].sort().join("-")) || 1,
      }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit);
  }
}

// ─── Global DSA instances ─────────────────────────────────────────────────────
const cartCache = new CartLRUCache(200);
const cartItemBloomFilter = new CartBloomFilter(50000, 5);
const recommendationGraph = new ProductRecommendationGraph();
const userCartMap = new Map();
const activeCartSessions = new Set();

// ─── Utility ──────────────────────────────────────────────────────────────────
function getWeightInGrams(weight) {
  return { "1kg": 1000, "500g": 500, "250g": 250, "100g": 100 }[weight] || 0;
}

// ─── GET /api/cart ────────────────────────────────────────────────────────────
export const getCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { sortBy = "addedAt", sortOrder = "desc" } = req.query;

  const cacheKey = `cart_${userId}`;
  let cart = cartCache.get(cacheKey);

  if (!cart) {
    cart = await Cart.getOrCreateCart(userId);
    cartCache.set(cacheKey, cart);
  }

  await cart.populate({
    path: "items.product",
    select: "name image category isAvailable",
  });

  // Sort via Priority Queue
  const pq = new CartPriorityQueue();
  cart.items.forEach((item, index) => {
    let priority = 0;
    switch (sortBy) {
      case "price":       priority = item.price;                              break;
      case "quantity":    priority = item.quantity;                           break;
      case "totalPrice":  priority = item.totalPrice;                         break;
      case "addedAt":
      default:            priority = new Date(item.addedAt).getTime();        break;
    }
    pq.enqueue({ ...item.toObject(), originalIndex: index }, sortOrder === "desc" ? -priority : priority);
  });

  const sortedItems = [];
  while (!pq.isEmpty()) sortedItems.push(pq.dequeue().item);

  res.status(200).json(
    new ApiResponse(200, {
      cart: { ...cart.toObject(), items: sortedItems },
      cacheStats: {
        cacheSize: cartCache.size,          // ✅ property, not method
        isCached: !!cartCache.get(cacheKey),
      },
    }, "Cart retrieved successfully")
  );
});

// ─── POST /api/cart/add ───────────────────────────────────────────────────────
export const addToCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId, quantity, weight } = req.body;

  if (!productId || !quantity || !weight) {
    throw new ApiError(400, "Product ID, quantity, and weight are required");
  }
  if (quantity < 1 || quantity > 99) {
    throw new ApiError(400, "Quantity must be between 1 and 99");
  }

  const product = await Vegetable.findById(productId);
  if (!product)          throw new ApiError(404, "Product not found");
  if (!product.isAvailable) throw new ApiError(400, "Product is not available");

  const weightPriceMap = {
    "1kg": product.weight1kg, "500g": product.weight500g,
    "250g": product.weight250g, "100g": product.weight100g,
  };
  const selectedWeightPrice = weightPriceMap[weight];
  if (!selectedWeightPrice) throw new ApiError(400, "Invalid weight selection");

  const itemSignature = `${userId}-${productId}-${weight}`;
  if (cartItemBloomFilter.mightContain(itemSignature)) {
    const existingCart = await Cart.findOne({ user: userId, status: "active" });
    if (existingCart) {
      const found = existingCart.items.find(
        (i) => i.product.toString() === productId && i.weight === weight
      );
      if (found) throw new ApiError(409, "Item already exists in cart. Use update quantity instead.");
    }
  }

  const cart = await Cart.getOrCreateCart(userId);
  await cart.addItem(productId, quantity, selectedWeightPrice, weight, getWeightInGrams(weight));

  cartItemBloomFilter.add(itemSignature);
  activeCartSessions.add(userId);
  userCartMap.set(userId, cart._id.toString());

  const currentProductIds = cart.items.map((i) => i.product.toString());
  recommendationGraph.addPurchase(currentProductIds);

  cartCache.set(`cart_${userId}`, cart);

  res.status(201).json(
    new ApiResponse(201, {
      cart: cart.toObject(),
      addedItem: { product: productId, quantity, weight, price: selectedWeightPrice },
    }, "Item added to cart successfully")
  );
});

// ─── PUT /api/cart/update ─────────────────────────────────────────────────────
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
  if (!cart) throw new ApiError(404, "Cart not found");

  if (quantity === 0) {
    await cart.removeItem(productId, weight);
  } else {
    await cart.updateItemQuantity(productId, weight, quantity);
  }

  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
      updatedItem: { product: productId, weight, quantity },
    }, "Cart item updated successfully")
  );
});

// ─── DELETE /api/cart/remove ──────────────────────────────────────────────────
export const removeFromCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { productId, weight } = req.body;

  if (!productId || !weight) throw new ApiError(400, "Product ID and weight are required");

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) throw new ApiError(404, "Cart not found");

  await cart.removeItem(productId, weight);
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, { cart: cart.toObject() }, "Item removed from cart successfully")
  );
});

// ─── DELETE /api/cart/clear ───────────────────────────────────────────────────
export const clearCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) throw new ApiError(404, "Cart not found");

  await cart.clearCart();

  cartCache.delete(`cart_${userId}`);
  activeCartSessions.delete(userId);
  userCartMap.delete(userId);

  res.status(200).json(
    new ApiResponse(200, { cart: cart.toObject() }, "Cart cleared successfully")
  );
});

// ─── POST /api/cart/coupon/apply ──────────────────────────────────────────────
export const applyCoupon = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { couponId, discountAmount } = req.body;

  if (!couponId || discountAmount === undefined) {
    throw new ApiError(400, "Coupon ID and discount amount are required");
  }

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) throw new ApiError(404, "Cart not found");

  await cart.applyCoupon(couponId, discountAmount);
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
      appliedCoupon: { couponId, discountAmount },
    }, "Coupon applied successfully")
  );
});

// ─── DELETE /api/cart/coupon ──────────────────────────────────────────────────
export const removeCoupon = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) throw new ApiError(404, "Cart not found");

  await cart.removeCoupon();
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, { cart: cart.toObject() }, "Coupon removed successfully")
  );
});

// ─── GET /api/cart/recommendations ───────────────────────────────────────────
export const getCartRecommendations = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { limit = 5 } = req.query;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart || cart.items.length === 0) {
    return res.status(200).json(
      new ApiResponse(200, { recommendations: [] }, "No recommendations available")
    );
  }

  const cartProductIds = cart.items.map((i) => i.product.toString());
  const allRecommendations = new Map();

  cartProductIds.forEach((productId) => {
    recommendationGraph.getRecommendations(productId, limit).forEach((rec) => {
      if (!cartProductIds.includes(rec.productId)) {
        allRecommendations.set(rec.productId, rec);
      }
    });
  });

  const topRecs = Array.from(allRecommendations.values())
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, Number(limit));

  const productIds = topRecs.map((r) => r.productId);
  const products = await Vegetable.find({ _id: { $in: productIds } })
    .select("name image price category")
    .limit(Number(limit));

  const recommendationsWithProducts = topRecs
    .map((rec) => ({
      ...rec,
      product: products.find((p) => p._id.toString() === rec.productId),
    }))
    .filter((rec) => rec.product);

  res.status(200).json(
    new ApiResponse(200, {
      recommendations: recommendationsWithProducts,
      basedOn: cartProductIds.length,
      algorithm: "Collaborative Filtering",
    }, "Cart recommendations retrieved successfully")
  );
});

// ─── GET /api/cart/analytics ──────────────────────────────────────────────────
export const getCartAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const cart = await Cart.findOne({ user: userId, status: "active" });
  if (!cart) throw new ApiError(404, "Cart not found");

  const analytics = {
    itemCount: cart.items.length,
    totalQuantity: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    averageItemPrice: cart.averageItemPrice,
    totalValue: cart.totalValue,
    priceDistribution: {},
    weightDistribution: {},
  };

  cart.items.forEach((item) => {
    const priceRange = Math.floor(item.price / 50) * 50;
    const rangeKey = `₹${priceRange}-₹${priceRange + 49}`;
    analytics.priceDistribution[rangeKey] = (analytics.priceDistribution[rangeKey] || 0) + 1;
    analytics.weightDistribution[item.weight] = (analytics.weightDistribution[item.weight] || 0) + 1;
  });

  res.status(200).json(
    new ApiResponse(200, {
      analytics,
      dsaPerformance: {
        cacheSize: cartCache.size,                              // ✅ property
        bloomFilterSize: cartItemBloomFilter.size,
        activeSessions: activeCartSessions.size,
        recommendationGraphNodes: recommendationGraph.adjacencyList.size,
      },
    }, "Cart analytics retrieved successfully")
  );
});

// ─── POST /api/cart/merge  ← THIS WAS MISSING (404) ──────────────────────────
export const mergeGuestCart = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { guestCartItems } = req.body;

  if (!guestCartItems || !Array.isArray(guestCartItems)) {
    throw new ApiError(400, "Guest cart items are required");
  }

  // Silently succeed if nothing to merge
  if (guestCartItems.length === 0) {
    return res.status(200).json(
      new ApiResponse(200, { mergedItems: 0 }, "Nothing to merge")
    );
  }

  const cart = await Cart.getOrCreateCart(userId);

  for (const guestItem of guestCartItems) {
    if (!guestItem.product || !guestItem.weight || !guestItem.quantity) continue;

    const existingItem = cart.items.find(
      (i) =>
        i.product.toString() === guestItem.product.toString() &&
        i.weight === guestItem.weight
    );

    if (existingItem) {
      existingItem.quantity = Math.min(existingItem.quantity + guestItem.quantity, 99);
      existingItem.totalPrice = existingItem.quantity * existingItem.price;
    } else {
      cart.items.push({
        product: guestItem.product,
        quantity: Math.min(guestItem.quantity, 99),
        weight: guestItem.weight,
        price: guestItem.price || 0,
        totalPrice: guestItem.totalPrice || 0,
        addedAt: new Date(),
      });
    }
  }

  await cart.save();
  cartCache.set(`cart_${userId}`, cart);

  res.status(200).json(
    new ApiResponse(200, {
      cart: cart.toObject(),
      mergedItems: guestCartItems.length,
    }, "Guest cart merged successfully")
  );
});