import Order from "../Model/order.js";
import User from "../Model/user.js";
import Vegetable from "../Model/vegetable.js";
import Basket from "../Model/basket.js";
import Coupon from "../Model/coupon.js";
import Address from "../Model/address.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiError } from "../utility/ApiError.js";
import { incrementCouponUsage } from "./coupon.js";
import { processOrderInvoice, sendInvoiceEmail } from "./invoice.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import nodemailer from "nodemailer";
import "dotenv/config";
import { DELIVERY_CHARGES } from "../../const.js";
import Wallet from "../Model/wallet.model.js";
import WalletTransaction from "../Model/walletTransaction.model.js";
import { rupeeToPaise, generateReferenceId } from "../utility/walletHelpers.js";
import mongoose from "mongoose";
import {
  calculateCashback,
  isCashbackEligible,
} from "../../config/cashback.config.js";

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL: Redis (L2 cache)
// ─────────────────────────────────────────────────────────────────────────────
let redis = null;
try {
  if (process.env.REDIS_URL) {
    const { default: Redis } = await import("ioredis");
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
  }
} catch {
  console.warn("[order] Redis unavailable — running without cache");
  redis = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL: BullMQ job queues
// ─────────────────────────────────────────────────────────────────────────────
let orderQueue = null;
try {
  if (redis) {
    const { Queue } = await import("bullmq");
    orderQueue = new Queue("orders", {
      connection: redis,
      defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    });
  }
} catch {
  console.warn("[order] BullMQ unavailable — using inline fire-and-forget");
  orderQueue = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NODEMAILER SINGLETON
// ─────────────────────────────────────────────────────────────────────────────
const emailTransporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
});
emailTransporter.verify().catch(() =>
  console.warn("[email] SMTP connection failed — emails may not send")
);

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  deliveryCharges: DELIVERY_CHARGES / 100,
  freeDeliveryThreshold: 269,
  orderIdRetries: 5,
  validStatuses: new Set(["placed", "processed", "shipped", "delivered", "cancelled"]),
  weightToKg: new Map([
    ["1kg", 1],
    ["500g", 0.5],
    ["250g", 0.25],
    ["100g", 0.1],
  ]),
  weightPriceMap: new Map([
    ["1kg", "weight1kg"],
    ["500g", "weight500g"],
    ["250g", "weight250g"],
    ["100g", "weight100g"],
  ]),
  maxOrderAmount: 100000,
  maxQuantity: 1000,
  maxItemsPerOrder: 50,
  cache: { vegetable: 300, coupon: 60, basket: 120 },
});

// ─────────────────────────────────────────────────────────────────────────────
// RAZORPAY SINGLETON
// ─────────────────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
// INPUT SANITIZATION
// ─────────────────────────────────────────────────────────────────────────────
const sanitizeString = (str) => {
  if (typeof str !== "string") return str;
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const validateNumeric = (value, min = 0, max = CONFIG.maxOrderAmount) => {
  const num = Number(value);
  if (isNaN(num) || num < min || num > max)
    throw new Error(`Invalid numeric value: ${value}`);
  return num;
};

// ─────────────────────────────────────────────────────────────────────────────
// TWO-LEVEL CACHE: L1 = in-process LRU, L2 = Redis
// ─────────────────────────────────────────────────────────────────────────────
class LRUCache {
  #capacity;
  #cache = new Map();

  constructor(capacity = 200) { this.#capacity = capacity; }

  get(key) {
    if (!this.#cache.has(key)) return null;
    const val = this.#cache.get(key);
    this.#cache.delete(key);
    this.#cache.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    } else if (this.#cache.size >= this.#capacity) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.set(key, value);
  }

  delete(key) { this.#cache.delete(key); }
  has(key) { return this.#cache.has(key); }
}

const l1 = new LRUCache(500);

const cacheGet = async (key) => {
  const l1hit = l1.get(key);
  if (l1hit !== null) return l1hit;
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      l1.set(key, parsed);
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
};

const cacheSet = async (key, value, ttlSeconds = 300) => {
  l1.set(key, value);
  if (!redis) return;
  try { await redis.setex(key, ttlSeconds, JSON.stringify(value)); } catch { /* ignore */ }
};

const cacheDel = async (key) => {
  l1.delete(key);
  if (!redis) return;
  try { await redis.del(key); } catch { /* ignore */ }
};

// ─────────────────────────────────────────────────────────────────────────────
// TRIE — fast coupon lookup
// ─────────────────────────────────────────────────────────────────────────────
class TrieNode {
  constructor() {
    this.children = Object.create(null);
    this.coupon = null;
  }
}

class CouponTrie {
  #root = new TrieNode();
  #loaded = false;

  insert(coupon) {
    let node = this.#root;
    for (const ch of coupon.code.toUpperCase()) {
      if (!node.children[ch]) node.children[ch] = new TrieNode();
      node = node.children[ch];
    }
    node.coupon = coupon;
  }

  remove(code) {
    let node = this.#root;
    for (const ch of code.toUpperCase()) {
      if (!node.children[ch]) return;
      node = node.children[ch];
    }
    node.coupon = null;
  }

  search(code) {
    let node = this.#root;
    for (const ch of code.toUpperCase()) {
      if (!node.children[ch]) return null;
      node = node.children[ch];
    }
    return node.coupon || null;
  }

  async ensureLoaded() {
    if (this.#loaded) return;
    const coupons = await Coupon.find({ isActive: true }).lean();
    for (const c of coupons) this.insert(c);
    this.#loaded = true;
  }

  invalidate(code) { this.remove(code); }
  reload(coupon) { this.insert(coupon); }
}

export const couponTrie = new CouponTrie();

// ─────────────────────────────────────────────────────────────────────────────
// CACHED VEGETABLE BATCH FETCH
// ─────────────────────────────────────────────────────────────────────────────
const fetchVegetablesBatch = async (ids) => {
  const result = new Map();
  const misses = [];

  for (const id of ids) {
    const key = `veg:${id}`;
    const cached = await cacheGet(key);
    if (cached) {
      result.set(id.toString(), cached);
    } else {
      misses.push(id);
    }
  }

  if (misses.length) {
    const fresh = await Vegetable.find({ _id: { $in: misses } }).lean();
    await Promise.all(
      fresh.map(async (v) => {
        const key = `veg:${v._id}`;
        await cacheSet(key, v, CONFIG.cache.vegetable);
        result.set(v._id.toString(), v);
        result.set(v.name, v);
      })
    );
  }

  return result;
};

export const invalidateVegetableCache = async (vegetableId) => {
  await cacheDel(`veg:${vegetableId}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// CACHED BASKET PRICE FETCH
// ─────────────────────────────────────────────────────────────────────────────
const fetchBasketPrice = async (basketId) => {
  const key = `basket:price:${basketId}`;
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  const basket = await Basket.findById(basketId, { price: 1 }).lean();
  if (!basket) throw new Error("Basket not found");
  await cacheSet(key, basket.price, CONFIG.cache.basket);
  return basket.price;
};

// ─────────────────────────────────────────────────────────────────────────────
// ORDER ID GENERATOR — uses Counter model if available, falls back to DB scan
// ─────────────────────────────────────────────────────────────────────────────
let Counter = null;
try {
  Counter = mongoose.model("Counter");
} catch {
  try {
    const { default: C } = await import("../Model/counter.js");
    Counter = C;
  } catch {
    Counter = null;
  }
}

const generateUniqueOrderId = async (retries = CONFIG.orderIdRetries) => {
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const cacheKey = `ORD${dateStr}`;

  if (Counter) {
    try {
      const doc = await Counter.findByIdAndUpdate(
        `orderId:${dateStr}`,
        { $inc: { seq: 1 } },
        { upsert: true, new: true }
      );
      return `${cacheKey}${String(doc.seq).padStart(3, "0")}`;
    } catch { /* fall through */ }
  }

  for (let i = 0; i < retries; i++) {
    try {
      const lastOrder = await Order.findOne(
        { orderId: { $regex: `^${cacheKey}` } },
        { orderId: 1 }
      )
        .sort({ orderId: -1 })
        .lean();

      const sequence = lastOrder ? parseInt(lastOrder.orderId.slice(-3)) + 1 : 1;
      const jitter = Math.floor(Math.random() * 3);
      const orderId = `${cacheKey}${String(sequence + jitter).padStart(3, "0")}`;

      if (!(await Order.exists({ orderId }))) return orderId;
    } catch (error) {
      if (i === retries - 1) {
        const timestamp = Date.now().toString().slice(-9);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
        return `ORD${timestamp}${random}`;
      }
      await new Promise((r) => setTimeout(r, 50 << i));
    }
  }
  throw new Error("Failed to generate order ID");
};

// ─────────────────────────────────────────────────────────────────────────────
// PRICE STRATEGIES — set-based & weight-based
// ─────────────────────────────────────────────────────────────────────────────
const priceStrategies = {
  set: (veg, setIdx, qty) => {
    const set = veg.setPricing?.sets?.[setIdx];
    if (!set) throw new Error(`Invalid set index: ${setIdx}`);
    return {
      type: "set",
      pricePerUnit: set.price,
      subtotal: set.price * qty,
      label: `${set.quantity} ${set.unit}`,
      setIndex: setIdx,
      setQuantity: set.quantity,
      setUnit: set.unit,
    };
  },
  weight: (veg, weight, qty) => {
    const price = veg.prices?.[CONFIG.weightPriceMap.get(weight)];
    if (!price) throw new Error(`Invalid weight: ${weight}`);
    return { type: "weight", pricePerUnit: price, subtotal: price * qty, weight };
  },
};

const getPrice = (veg, weightOrSet, qty = 1) => {
  const isSet = veg.pricingType === "set" || veg.setPricing?.enabled;
  const setIdx = weightOrSet.startsWith("set")
    ? parseInt(weightOrSet.slice(3))
    : parseInt(weightOrSet);
  return isSet
    ? priceStrategies.set(veg, setIdx, qty)
    : priceStrategies.weight(veg, weightOrSet, qty);
};

// ─────────────────────────────────────────────────────────────────────────────
// STOCK UPDATE — atomic findOneAndUpdate (no race condition)
// ─────────────────────────────────────────────────────────────────────────────
const updateStock = async (items, operation = "deduct", session = null) => {
  const vegIds = [...new Set(items.map((i) => i.vegetable))];
  const vegMap = await fetchVegetablesBatch(vegIds.map((id) => id.toString()));
  const updates = [];

  for (const item of items) {
    const veg = vegMap.get(item.vegetable.toString());
    if (!veg) throw new Error(`Vegetable not found: ${item.vegetable}`);

    const isSet = veg.pricingType === "set" || veg.setPricing?.enabled;
    const setIdx = item.setIndex ?? parseInt(item.weight?.slice(3) || "0");

    if (isSet) {
      const pieces = veg.setPricing.sets[setIdx].quantity * item.quantity;
      const delta = operation === "deduct" ? -pieces : pieces;

      if (operation === "deduct") {
        const updated = await Vegetable.findOneAndUpdate(
          { _id: item.vegetable, stockPieces: { $gte: pieces } },
          {
            $inc: { stockPieces: delta },
            $set: { outOfStock: veg.stockPieces + delta <= 0 },
          },
          session ? { new: true, session } : { new: true }
        );
        if (!updated) throw new Error(`Insufficient stock for ${veg.name}`);
      } else {
        await Vegetable.findOneAndUpdate(
          { _id: item.vegetable },
          { $inc: { stockPieces: delta }, $set: { outOfStock: false } },
          session ? { session } : {}
        );
      }

      await invalidateVegetableCache(item.vegetable.toString());
      updates.push({
        vegetableId: item.vegetable,
        vegetableName: veg.name,
        [operation === "deduct" ? "deducted" : "restored"]: pieces,
        previousStock: veg.stockPieces,
        type: "pieces",
      });
    } else {
      const kg = CONFIG.weightToKg.get(item.weight) * item.quantity;
      const delta = operation === "deduct" ? -kg : kg;

      if (operation === "deduct") {
        const updated = await Vegetable.findOneAndUpdate(
          { _id: item.vegetable, stockKg: { $gte: kg } },
          {
            $inc: { stockKg: delta },
            $set: { outOfStock: veg.stockKg + delta < 0.25 },
          },
          session ? { new: true, session } : { new: true }
        );
        if (!updated) throw new Error(`Insufficient stock for ${veg.name}`);
      } else {
        await Vegetable.findOneAndUpdate(
          { _id: item.vegetable },
          { $inc: { stockKg: delta }, $set: { outOfStock: false } },
          session ? { session } : {}
        );
      }

      await invalidateVegetableCache(item.vegetable.toString());
      updates.push({
        vegetableId: item.vegetable,
        vegetableName: veg.name,
        [operation === "deduct" ? "deducted" : "restored"]: kg,
        previousStock: veg.stockKg,
        type: "kg",
      });
    }
  }

  return updates;
};

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER PROCESSING — upsert user by phone
// ─────────────────────────────────────────────────────────────────────────────
const processCustomer = async (info) => {
  if (typeof info === "string") {
    if (!(await User.exists({ _id: info }))) throw new Error("User not found");
    return info;
  }
  if (info._id) return info._id;

  const phone = info.phone || info.mobile;
  if (!phone) throw new Error("Phone required");

  try {
    let user = await User.findOne({ phone });

    if (!user) {
      user = await User.create({
        ...(info.name && { username: info.name }),
        ...(info.email && { email: info.email }),
        phone,
        isApproved: true,
        role: "user",
      });
    } else {
      Object.assign(user, {
        ...(info.name && { username: info.name }),
        ...(info.email && { email: info.email }),
      });
      await user.save();
    }

    if (info.address || info.city || info.area) {
      const existingAddresses = await Address.find({ user: user._id });
      const addressData = {
        street: info.address || "N/A",
        area: info.area || "N/A",
        city: info.city || "N/A",
        state: info.state || "Gujarat",
        pincode: info.zipCode || info.pincode || "000000",
        country: "India",
        type: info.addressType || "home",
        isDefault: existingAddresses.length === 0,
      };

      const similarAddress = existingAddresses.find(
        (addr) =>
          addr.street === addressData.street &&
          addr.city === addressData.city &&
          addr.area === addressData.area
      );

      if (!similarAddress) {
        await user.addAddress(addressData);
      } else if (existingAddresses.length === 1) {
        await user.setDefaultAddress(similarAddress._id);
      }
    }

    return user._id;
  } catch (err) {
    if (err.code === 11000 && info.email) {
      const user = await User.findOne({ email: info.email });
      if (user) return user._id;
    }
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// VEG ID EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────
const getVegId = (item) => {
  if (!item) return null;
  if (typeof item === "string") return item;
  if (item instanceof mongoose.Types.ObjectId) return item.toString();

  if (item.vegetable) {
    if (typeof item.vegetable === "string") return item.vegetable;
    if (item.vegetable instanceof mongoose.Types.ObjectId)
      return item.vegetable.toString();
    return item.vegetable._id || item.vegetable.id;
  }
  return item._id || item.id || item.name;
};

// ─────────────────────────────────────────────────────────────────────────────
// VEGETABLE PROCESSING — group duplicates, validate quantities
// ─────────────────────────────────────────────────────────────────────────────
const processVegetables = async (items, isBasket = false) => {
  if (!Array.isArray(items) || !items.length) throw new Error("Items required");

  if (items.length > CONFIG.maxItemsPerOrder)
    throw new Error(`Maximum ${CONFIG.maxItemsPerOrder} items allowed per order`);

  const vegIds = [...new Set(items.map(getVegId).filter(Boolean))];
  if (!vegIds.length) throw new Error("No valid items");

  const isObjectId = /^[0-9a-fA-F]{24}$/.test(vegIds[0]);
  let vegMap;

  if (isObjectId) {
    vegMap = await fetchVegetablesBatch(vegIds);
  } else {
    const vegetables = await Vegetable.find({
      $or: [{ name: { $in: vegIds } }, { _id: { $in: vegIds } }],
    }).lean();

    if (vegetables.length !== vegIds.length)
      throw new Error(`Missing vegetables: ${vegIds.length - vegetables.length}`);

    vegMap = new Map();
    vegetables.forEach((v) => {
      vegMap.set(v._id.toString(), v);
      vegMap.set(v.name, v);
    });
  }

  if (vegMap.size === 0) throw new Error("Missing vegetables");

  const grouped = new Map();

  for (const item of items) {
    const id = getVegId(item);
    const veg = vegMap.get(id?.toString()) || vegMap.get(id);
    if (!veg) throw new Error(`Vegetable not found: ${id}`);

    const weight = item.weight || "1kg";
    const qty = item.quantity || 1;

    if (qty < 1 || qty > CONFIG.maxQuantity)
      throw new Error(`Invalid quantity for ${veg.name}: ${qty}`);

    const key = `${veg._id}_${weight}`;

    if (grouped.has(key)) {
      const existing = grouped.get(key);
      existing.quantity += qty;
      existing.subtotal = existing.pricePerUnit * existing.quantity;
    } else {
      const priceInfo = getPrice(veg, weight, qty);
      grouped.set(key, {
        vegetable: veg._id,
        quantity: qty,
        pricePerUnit: priceInfo.pricePerUnit,
        subtotal: priceInfo.subtotal,
        isFromBasket: isBasket,
        ...(priceInfo.type === "set"
          ? {
              weight,
              setIndex: priceInfo.setIndex,
              setLabel: priceInfo.label,
              setQuantity: priceInfo.setQuantity,
              setUnit: priceInfo.setUnit,
            }
          : { weight: priceInfo.weight }),
      });
    }
  }

  return Array.from(grouped.values());
};

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL ORDER DATA PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
const processOrderData = async (customer, basket, vegetables, type = "custom") => {
  try {
    const [customerId, basketId, processedVegs] = await Promise.all([
      processCustomer(customer),
      type === "basket" && basket
        ? Basket.findById(typeof basket === "string" ? basket : basket._id, { _id: 1 })
            .lean()
            .then((b) => {
              if (!b) throw new Error("Basket not found");
              return b._id;
            })
        : null,
      processVegetables(vegetables, type === "basket"),
    ]);
    return { customerId, basketId, processedVegetables: processedVegs };
  } catch (error) {
    return { error: error.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// COUPON VALIDATION — Trie → cache → DB fallback
// ─────────────────────────────────────────────────────────────────────────────
const validateCoupon = async (code, subtotal, userId = null) => {
  if (!code) {
    return { couponId: null, couponDiscount: 0, validatedCouponCode: null, couponDetails: null };
  }

  const upperCode = code.toUpperCase();

  await couponTrie.ensureLoaded();
  let coupon = couponTrie.search(upperCode);

  if (!coupon) {
    const key = `coupon:${upperCode}`;
    coupon = await cacheGet(key);
  }

  if (!coupon) {
    coupon = await Coupon.findOne({ code: upperCode, isActive: true }).lean();
    if (coupon) {
      await cacheSet(`coupon:${upperCode}`, coupon, CONFIG.cache.coupon);
      couponTrie.reload(coupon);
    }
  }

  if (!coupon) throw new Error("Invalid coupon");
  if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date())
    throw new Error("Coupon expired");
  if (coupon.minOrderAmount && subtotal < coupon.minOrderAmount)
    throw new Error(`Minimum ₹${coupon.minOrderAmount} required`);
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit)
    throw new Error("Coupon limit reached");
  if (userId && coupon.perUserLimit) {
    const userUsage =
      coupon.usedBy?.filter((id) => id.toString() === userId.toString()).length || 0;
    if (userUsage >= coupon.perUserLimit) throw new Error("User limit reached");
  }

  const discount =
    coupon.discountType === "percentage"
      ? Math.min((subtotal * coupon.discountValue) / 100, coupon.maxDiscount || Infinity)
      : Math.min(coupon.discountValue, subtotal);

  return {
    couponId: coupon._id,
    couponDiscount: discount,
    validatedCouponCode: coupon.code,
    couponDetails: {
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      applied: true,
      discount,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ORDER TOTAL CALCULATION
// ─────────────────────────────────────────────────────────────────────────────
const calculateOrderTotal = (vegs, basketPrice = null, type = "custom", discount = 0) => {
  const vegTotal = vegs.reduce((sum, i) => sum + i.subtotal, 0);

  if (type === "basket") {
    if (!basketPrice) throw new Error("Basket price required");
    const afterDiscount = Math.max(0, basketPrice - discount);
    return {
      vegetablesTotal: vegTotal,
      basketPrice,
      couponDiscount: discount,
      subtotalAfterDiscount: afterDiscount,
      deliveryCharges: CONFIG.deliveryCharges,
      totalAmount: afterDiscount + CONFIG.deliveryCharges,
    };
  }

  const afterDiscount = Math.max(0, vegTotal - discount);
  const delivery = afterDiscount > CONFIG.freeDeliveryThreshold ? 0 : CONFIG.deliveryCharges;

  return {
    vegetablesTotal: vegTotal,
    basketPrice: 0,
    couponDiscount: discount,
    subtotalAfterDiscount: afterDiscount,
    deliveryCharges: delivery,
    totalAmount: afterDiscount + delivery,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// CLEAN ORDER DATA — strip undefined, ensure required defaults
// ─────────────────────────────────────────────────────────────────────────────
const cleanOrderData = (data) => {
  const cleaned = { ...data };

  Object.keys(cleaned).forEach((key) => {
    if (cleaned[key] === undefined) delete cleaned[key];
  });

  delete cleaned.stockUpdates;

  cleaned.walletCreditUsed = cleaned.walletCreditUsed || 0;
  cleaned.cashbackAmount = cleaned.cashbackAmount || 0;
  cleaned.cashbackEligible = cleaned.cashbackEligible || false;
  cleaned.couponCode = cleaned.couponCode || null;
  cleaned.couponId = cleaned.couponId || null;
  cleaned.deliveryAddressId = cleaned.deliveryAddressId || null;

  if (cleaned.finalPayableAmount === undefined || cleaned.finalPayableAmount === null) {
    cleaned.finalPayableAmount = Math.max(
      0,
      cleaned.totalAmount - (cleaned.walletCreditUsed || 0)
    );
  }

  return cleaned;
};

// ─────────────────────────────────────────────────────────────────────────────
// ORDER CREATION WITH RETRY — duplicate orderId safe
// ─────────────────────────────────────────────────────────────────────────────
const createOrderWithRetry = async (data, maxRetries = CONFIG.orderIdRetries, session = null) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const orderId = data.orderId || (await generateUniqueOrderId());
      const cleanedData = cleanOrderData({ ...data, orderId });
      const order = await Order.create([cleanedData], { session });
      return { order: order[0], orderId };
    } catch (err) {
      if (err.code === 11000 && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 50 << i));
        continue;
      }

      console.error("Order creation failed:", err.name, err.code);

      if (err.code === 121 && err.errInfo)
        console.error("MongoDB $jsonSchema validation:", JSON.stringify(err.errInfo, null, 2));

      if (err.name === "ValidationError")
        throw new Error("Order validation failed. Please check your order details.");
      else if (err.code === 11000)
        throw new Error("Duplicate order detected. Please try again.");
      else if (err.code === 121)
        throw new Error("Order validation failed. Please try again or contact support.");
      else
        throw new Error("Failed to create order. Please try again.");
    }
  }
  throw new Error("Failed to create order after multiple attempts");
};

// ─────────────────────────────────────────────────────────────────────────────
// CASHBACK — atomic idempotent credit
// ─────────────────────────────────────────────────────────────────────────────
async function creditCashbackToWallet(order) {
  try {
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        cashbackCredited: false,
        cashbackEligible: true,
        cashbackAmount: { $gt: 0 },
      },
      { $set: { cashbackCredited: true, cashbackCreditedAt: new Date() } },
      { new: false }
    );

    if (!claimed)
      return { success: false, reason: "Already credited or not eligible" };

    let wallet = await Wallet.findByUserId(order.customerInfo);
    if (!wallet) wallet = await Wallet.createWallet(order.customerInfo);
    if (!wallet.isActive()) return { success: false, reason: "Wallet inactive" };

    const transaction = await WalletTransaction.createCreditTransaction(
      wallet._id,
      "cashback",
      `CASH_${order.orderId}`,
      Math.round(order.cashbackAmount * 100),
      `Cashback for order ${order.orderId}`
    );

    return { success: true, amount: order.cashbackAmount, transaction: transaction[0] };
  } catch (error) {
    console.error("Cashback credit failed");
    return { success: false, error: error.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASYNC JOB DISPATCHER — BullMQ if available, else fire-and-forget
// ─────────────────────────────────────────────────────────────────────────────
const dispatchOrderJobs = async (order, opts = { cashback: false }) => {
  if (orderQueue) {
    const jobs = [
      orderQueue.add("invoice", { orderId: order._id, sendEmail: true, emailType: "invoice" }),
      orderQueue.add("admin-notify", { orderId: order._id }),
    ];
    if (opts.cashback) jobs.push(orderQueue.add("cashback", { orderId: order._id }));
    await Promise.allSettled(jobs);
  } else {
    processOrderInvoice(order._id, { sendEmail: true, emailType: "invoice" }).catch(() => {});
    sendAdminOrderNotification(order).catch(() => {});
    if (opts.cashback) creditCashbackToWallet(order).catch(() => {});
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN EMAIL — uses singleton transporter
// ─────────────────────────────────────────────────────────────────────────────
const sendAdminOrderNotification = async (order) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
    if (!adminEmail) { console.warn("Admin email not configured"); return; }

    await emailTransporter.sendMail({
      from: { name: "VegBazar Admin", address: process.env.EMAIL_USER },
      to: adminEmail,
      subject: `Order #${order.orderId} - ₹${(order.totalAmount || 0).toFixed(2)}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
          <div style="background:#0e540b;color:white;padding:15px;text-align:center;">
            <h2 style="margin:0;">New Order</h2>
          </div>
          <div style="padding:15px;background:#f8f9fa;border:1px solid #ddd;">
            <p>Order #<strong>${order.orderId}</strong> placed</p>
            <p>Customer: ${order.customerInfo?.name || "Unknown"}</p>
            <p>Amount: ₹${(order.totalAmount || 0).toFixed(2)}</p>
          </div>
        </div>`,
    });
  } catch {
    console.error(`Failed to send admin notification for order ${order.orderId}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POPULATE HELPER
// ─────────────────────────────────────────────────────────────────────────────
const populateOrder = (orderId) =>
  Order.findById(orderId)
    .populate("customerInfo", "name email phone")
    .populate("deliveryAddressId")
    .populate({
      path: "selectedBasket",
      populate: { path: "vegetables.vegetable", select: "name" },
    })
    .populate("selectedVegetables.vegetable", "name")
    .lean();

// ─────────────────────────────────────────────────────────────────────────────
// WALLET DEBIT HELPER — safe, re-verifies balance inside session
// ─────────────────────────────────────────────────────────────────────────────
const debitWallet = async (customerId, walletRef, amountRupees, orderId, description, session) => {
  const walletDoc = walletRef ?? (await Wallet.findByUserId(customerId));
  if (!walletDoc) throw new Error("Wallet not found for debit");
  if (!walletDoc.isActive()) throw new Error("Wallet inactive");

  const amountInPaise = rupeeToPaise(amountRupees);
  const currentBalance = await WalletTransaction.getCurrentBalance(walletDoc._id);

  if (currentBalance < amountInPaise) {
    throw new Error(
      `Wallet balance insufficient: required ₹${amountRupees}, available ₹${currentBalance / 100}`
    );
  }

  await WalletTransaction.createDebitTransaction(
    walletDoc._id,
    "order_payment",
    orderId,
    amountInPaise,
    description,
    session
  );

  return { walletId: walletDoc._id, amountInPaise, previousBalance: currentBalance };
};

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY ORDER COUNT HELPER — used by cashback calculation
// ─────────────────────────────────────────────────────────────────────────────
const getWeeklyOrderCount = async (customerId) => {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  return Order.countDocuments({
    customerInfo: customerId,
    orderStatus: { $in: ["placed", "processed", "shipped", "delivered"] },
    createdAt: { $gte: startOfWeek },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLERS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/orders/today/total
export const calculateTodayOrderTotal = asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const count = await Order.countDocuments({
    createdAt: { $gte: today, $lt: tomorrow },
  });

  res.json(new ApiResponse(200, { count }, "Today's order count fetched"));
});

// GET /api/orders  (admin, paginated)
export const getOrders = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.status) filter.paymentStatus = sanitizeString(req.query.status);
  if (req.query.paymentMethod) filter.paymentMethod = sanitizeString(req.query.paymentMethod);
  if (req.query.orderType) filter.orderType = sanitizeString(req.query.orderType);

  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter)
      .populate("customerInfo")
      .populate("deliveryAddressId")
      .populate({
        path: "selectedBasket",
        populate: { path: "vegetables.vegetable", select: "name" },
      })
      .populate("selectedVegetables.vegetable")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        orders,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalOrders: total,
          hasMore: page * limit < total,
        },
      },
      "Orders fetched"
    )
  );
});

// GET /api/orders/:orderId
export const getOrderById = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  if (!/^ORD\d{9,12}$/.test(orderId))
    return res.status(400).json(new ApiResponse(400, null, "Invalid order ID"));

  const order = await Order.findOne({ orderId })
    .populate("customerInfo")
    .populate({ path: "deliveryAddress", populate: { path: "user" } })
    .populate({
      path: "selectedBasket",
      populate: { path: "vegetables.vegetable", select: "name" },
    })
    .populate("selectedVegetables.vegetable")
    .lean();

  if (!order) return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  res.json(new ApiResponse(200, order, "Order fetched"));
});

// POST /api/orders/add  — COD / WALLET / ONLINE
export const addOrder = asyncHandler(async (req, res) => {
  const {
    customerInfo,
    selectedBasket,
    selectedVegetables,
    paymentMethod,
    orderType,
    couponCode,
    deliveryAddressId,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!customerInfo)
    return res.status(400).json(new ApiResponse(400, null, "Customer info required"));
  if (!["basket", "custom"].includes(orderType))
    return res.status(400).json(new ApiResponse(400, null, "Invalid order type"));
  if (orderType === "basket" && !selectedBasket)
    return res.status(400).json(new ApiResponse(400, null, "Basket required"));
  if (!Array.isArray(selectedVegetables) || !selectedVegetables.length)
    return res.status(400).json(new ApiResponse(400, null, "Items required"));
  if (!["COD", "ONLINE", "WALLET", "WALLET_COD", "WALLET_ONLINE"].includes(paymentMethod))
    return res.status(400).json(new ApiResponse(400, null, "Invalid payment method"));

  // Normalize hybrid payment methods: WALLET_COD → COD flow, WALLET_ONLINE → ONLINE flow
  const basePaymentMethod = paymentMethod === "WALLET_COD"
    ? "COD"
    : paymentMethod === "WALLET_ONLINE"
      ? "ONLINE"
      : paymentMethod;

  // ── Process customer + basket + vegetables in parallel ──────────────────
  const processed = await processOrderData(
    customerInfo,
    selectedBasket,
    selectedVegetables,
    orderType
  );

  if (processed.error)
    return res.status(400).json(new ApiResponse(400, null, processed.error));

  const { customerId, basketId, processedVegetables } = processed;

  // ── Basket price (cached) ────────────────────────────────────────────────
  let basketPrice = null;
  if (orderType === "basket") {
    try {
      basketPrice = await fetchBasketPrice(basketId);
    } catch {
      return res.status(404).json(new ApiResponse(404, null, "Basket not found"));
    }
  }

  const subtotal =
    orderType === "basket"
      ? basketPrice
      : processedVegetables.reduce((sum, i) => sum + i.subtotal, 0);

  if (subtotal <= 0 || subtotal > CONFIG.maxOrderAmount)
    return res.status(400).json(new ApiResponse(400, null, "Invalid order amount"));

  // ── Coupon + wallet fetch in parallel ───────────────────────────────────
  const [couponResult, walletResult] = await Promise.allSettled([
    couponCode ? validateCoupon(couponCode, subtotal, customerId) : Promise.resolve(null),
    Wallet.findByUserId(customerId),
  ]);

  let couponId = null, couponDiscount = 0, validatedCode = null;
  if (couponCode) {
    if (couponResult.status === "rejected")
      return res.status(400).json(new ApiResponse(400, null, couponResult.reason.message));
    const v = couponResult.value;
    couponId = v.couponId;
    couponDiscount = v.couponDiscount;
    validatedCode = v.validatedCouponCode;
  }

  const totals = calculateOrderTotal(processedVegetables, basketPrice, orderType, couponDiscount);

  // ── Wallet credit: only applied when user explicitly opts in ────────────
  let walletCreditUsed = 0;
  let finalPayableAmount = totals.totalAmount;
  const wallet = walletResult.status === "fulfilled" ? walletResult.value : null;

  const isWalletPayment = ["WALLET", "WALLET_COD", "WALLET_ONLINE"].includes(paymentMethod);

  if (isWalletPayment && wallet && wallet.isActive()) {
    try {
      const walletBalance = await WalletTransaction.getCurrentBalance(wallet._id);
      const walletBalanceInRupees = walletBalance / 100;
      walletCreditUsed = Math.min(walletBalanceInRupees, totals.totalAmount);
      finalPayableAmount = Math.max(0, totals.totalAmount - walletCreditUsed);
    } catch {
      walletCreditUsed = 0;
      finalPayableAmount = totals.totalAmount;
    }
  }

  // ── COD ──────────────────────────────────────────────────────────────────
  if (basePaymentMethod === "COD") {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await updateStock(processedVegetables, "deduct", session);

      const orderId = await generateUniqueOrderId();
      const completedOrderCount = await getWeeklyOrderCount(customerId);

      const cashbackAmount = calculateCashback(
        { finalPayableAmount, totalAmount: totals.totalAmount, paymentMethod: "COD", walletCreditUsed },
        customerId,
        completedOrderCount
      );
      const cashbackEligible = cashbackAmount > 0;

      const result = await createOrderWithRetry(
        {
          orderId,
          orderType,
          customerInfo: customerId,
          selectedVegetables: processedVegetables,
          orderDate: new Date(),
          couponCode: validatedCode,
          couponId,
          ...totals,
          walletCreditUsed,
          finalPayableAmount,
          cashbackEligible,
          cashbackAmount,
          paymentMethod: "COD",
          paymentStatus: finalPayableAmount === 0 ? "completed" : "pending",
          orderStatus: "placed",
          deliveryAddressId,
          ...(orderType === "basket" && { selectedBasket: basketId }),
        },
        CONFIG.orderIdRetries,
        session
      );

      if (walletCreditUsed > 0) {
        await debitWallet(
          customerId,
          wallet,
          walletCreditUsed,
          result.orderId,
          `Wallet credit applied to order ${result.orderId}`,
          session
        );
      }

      if (couponId) await incrementCouponUsage(couponId, customerId, session);

      await User.findByIdAndUpdate(
        customerId,
        { $push: { orders: result.order._id } },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populated = await populateOrder(result.order._id);
      await dispatchOrderJobs(populated, { cashback: cashbackEligible && cashbackAmount > 0 });

      return res.json(new ApiResponse(201, populated, "Order placed with COD"));
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json(new ApiResponse(500, null, err.message));
    }
  }

  // ── WALLET ────────────────────────────────────────────────────────────────
  if (basePaymentMethod === "WALLET") {
    if (finalPayableAmount > 0) {
      return res.status(400).json(
        new ApiResponse(
          400,
          {
            totalAmount: totals.totalAmount,
            walletBalance: walletCreditUsed,
            shortfall: finalPayableAmount,
          },
          "Insufficient wallet balance"
        )
      );
    }

    if (!wallet)
      return res.status(404).json(new ApiResponse(404, null, "Wallet not found"));
    if (!wallet.isActive())
      return res.status(400).json(new ApiResponse(400, null, "Wallet inactive"));

    // Pre-session balance check (early exit before stock deduction)
    const currentBalance = await WalletTransaction.getCurrentBalance(wallet._id);
    const amountInPaise = rupeeToPaise(totals.totalAmount);

    if (currentBalance < amountInPaise) {
      return res.status(400).json(
        new ApiResponse(
          400,
          {
            required: totals.totalAmount,
            available: currentBalance / 100,
            shortfall: (amountInPaise - currentBalance) / 100,
          },
          "Insufficient wallet balance"
        )
      );
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await updateStock(processedVegetables, "deduct", session);

      const orderId = await generateUniqueOrderId();
      const completedOrderCount = await getWeeklyOrderCount(customerId);

      const cashbackAmount = calculateCashback(
        { finalPayableAmount: 0, totalAmount: totals.totalAmount, paymentMethod: "WALLET", walletCreditUsed: totals.totalAmount },
        customerId,
        completedOrderCount
      );
      const cashbackEligible = cashbackAmount > 0;

      const result = await createOrderWithRetry(
        {
          orderId,
          orderType,
          customerInfo: customerId,
          selectedVegetables: processedVegetables,
          orderDate: new Date(),
          couponCode: validatedCode,
          couponId,
          ...totals,
          walletCreditUsed: totals.totalAmount,
          finalPayableAmount: 0,
          cashbackEligible,
          cashbackAmount,
          paymentMethod: "WALLET",
          paymentStatus: "completed",
          orderStatus: "placed",
          deliveryAddressId,
          ...(orderType === "basket" && { selectedBasket: basketId }),
        },
        CONFIG.orderIdRetries,
        session
      );

      await debitWallet(
        customerId,
        wallet,
        totals.totalAmount,
        result.orderId,
        `Payment for order ${result.orderId}`,
        session
      );

      if (couponId) await incrementCouponUsage(couponId, customerId, session);

      await User.findByIdAndUpdate(
        customerId,
        { $push: { orders: result.order._id } },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      const populated = await populateOrder(result.order._id);
      await dispatchOrderJobs(populated, { cashback: cashbackEligible && cashbackAmount > 0 });

      return res.json(
        new ApiResponse(
          201,
          {
            ...populated,
            walletDebit: {
              amount: totals.totalAmount,
              previousBalance: currentBalance / 100,
              newBalance: (currentBalance - amountInPaise) / 100,
            },
          },
          "Order placed with wallet"
        )
      );
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json(new ApiResponse(500, null, error.message));
    }
  }

  // ── ONLINE (Razorpay) ─────────────────────────────────────────────────────
  const orderId = await generateUniqueOrderId();
  const razorpayOrder = await razorpay.orders.create({
    amount: Math.round(finalPayableAmount * 100),
    currency: "INR",
    receipt: orderId,
    payment_capture: 1,
    // Store walletCreditUsed in Razorpay notes — verifyPayment reads from here
    // so we never trust the client-sent value
    notes: {
      walletCreditUsed: String(walletCreditUsed),
      orderId,
    },
  });

  const completedOrderCount = await getWeeklyOrderCount(customerId);
  const cashbackAmount = calculateCashback(
    { finalPayableAmount, totalAmount: totals.totalAmount, paymentMethod: "ONLINE", walletCreditUsed },
    customerId,
    completedOrderCount
  );
  const cashbackEligible = cashbackAmount > 0;

  res.json(
    new ApiResponse(
      201,
      {
        razorpayOrder,
        walletInfo: {
          walletCreditUsed,
          originalAmount: totals.totalAmount,
          finalPayableAmount,
        },
        orderData: {
          orderType,
          customerInfo: customerId,
          selectedVegetables: processedVegetables,
          orderId,
          couponCode: validatedCode,
          couponId,
          ...totals,
          walletCreditUsed,
          finalPayableAmount,
          cashbackEligible,
          cashbackAmount,
          deliveryAddressId,
          ...(orderType === "basket" && { selectedBasket: basketId }),
        },
      },
      "Razorpay order created"
    )
  );
});

// POST /api/orders/verify-payment
export const verifyPayment = asyncHandler(async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    customerInfo,
    selectedBasket,
    selectedVegetables,
    orderId,
    orderType,
    couponCode,
    deliveryAddressId,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json(new ApiResponse(400, null, "Missing payment data"));
  if (!customerInfo || !selectedVegetables || !orderId)
    return res.status(400).json(new ApiResponse(400, null, "Missing order data"));
  if (!["basket", "custom"].includes(orderType))
    return res.status(400).json(new ApiResponse(400, null, "Invalid order type"));
  if (orderType === "basket" && !selectedBasket)
    return res.status(400).json(new ApiResponse(400, null, "Missing basket"));

  // ── Signature verification ───────────────────────────────────────────────
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSig !== razorpay_signature)
    return res.status(400).json(new ApiResponse(400, null, "Invalid signature"));

  // ── Duplicate check ──────────────────────────────────────────────────────
  const [paymentExists, orderIdExists] = await Promise.all([
    Order.exists({ razorpayPaymentId: razorpay_payment_id }),
    Order.exists({ orderId }),
  ]);

  if (paymentExists)
    return res.status(400).json(new ApiResponse(400, null, "Payment already processed"));
  if (orderIdExists)
    return res.status(400).json(new ApiResponse(400, null, "Order ID already exists"));

  const processed = await processOrderData(
    customerInfo,
    selectedBasket,
    selectedVegetables,
    orderType
  );

  if (processed.error)
    return res.status(400).json(new ApiResponse(400, null, processed.error));

  const { customerId, basketId, processedVegetables } = processed;

  let basketPrice = null;
  if (orderType === "basket") {
    try {
      basketPrice = await fetchBasketPrice(basketId);
    } catch {
      return res.status(404).json(new ApiResponse(404, null, "Basket not found"));
    }
  }

  const subtotal =
    orderType === "basket"
      ? basketPrice
      : processedVegetables.reduce((sum, i) => sum + i.subtotal, 0);

  let couponId = null, couponDiscount = 0, validatedCode = null;
  if (couponCode) {
    try {
      const v = await validateCoupon(couponCode, subtotal, customerId);
      couponId = v.couponId;
      couponDiscount = v.couponDiscount;
      validatedCode = v.validatedCouponCode;
    } catch (err) {
      console.warn(`[verifyPayment] Coupon '${couponCode}' failed after payment: ${err.message}`);
    }
  }

  const totals = calculateOrderTotal(processedVegetables, basketPrice, orderType, couponDiscount);

  // ── Read wallet credit from Razorpay notes (secure — not from client) ────
  let walletCreditUsed = 0;
  let finalPayableAmount = totals.totalAmount;

  try {
    const rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
    const lockedCredit = parseFloat(rzpOrder.notes?.walletCreditUsed || "0");
    if (!isNaN(lockedCredit) && lockedCredit > 0) {
      walletCreditUsed = lockedCredit;
      finalPayableAmount = Math.max(0, totals.totalAmount - walletCreditUsed);
    }
  } catch {
    console.error("[verifyPayment] Could not fetch Razorpay notes — proceeding without wallet credit");
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    await updateStock(processedVegetables, "deduct", session);

    const completedOrderCount = await getWeeklyOrderCount(customerId);
    const cashbackAmount = calculateCashback(
      { finalPayableAmount, totalAmount: totals.totalAmount, paymentMethod: "ONLINE", walletCreditUsed },
      customerId,
      completedOrderCount
    );
    const cashbackEligible = cashbackAmount > 0;

    const result = await createOrderWithRetry(
      {
        orderId,
        orderType,
        customerInfo: customerId,
        selectedVegetables: processedVegetables,
        orderDate: new Date(),
        couponCode: validatedCode,
        couponId,
        ...totals,
        walletCreditUsed,
        finalPayableAmount,
        cashbackEligible,
        cashbackAmount,
        paymentMethod: "ONLINE",
        orderStatus: "placed",
        paymentStatus: "completed",
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        deliveryAddressId,
        ...(orderType === "basket" && { selectedBasket: basketId }),
      },
      CONFIG.orderIdRetries,
      session
    );

    if (walletCreditUsed > 0) {
      await debitWallet(
        customerId,
        null, // re-fetched fresh inside debitWallet to catch race conditions
        walletCreditUsed,
        result.orderId,
        `Wallet credit applied to order ${result.orderId}`,
        session
      );
    }

    if (couponId) await incrementCouponUsage(couponId, customerId, session);

    await User.findByIdAndUpdate(
      customerId,
      { $push: { orders: result.order._id } },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const populated = await populateOrder(result.order._id);
    await dispatchOrderJobs(populated, { cashback: cashbackEligible && cashbackAmount > 0 });

    res.json(new ApiResponse(200, populated, "Payment verified"));
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    if (processedVegetables?.length) {
      try {
        await updateStock(processedVegetables, "restore");
      } catch (restoreErr) {
        console.error("Stock restore failed:", restoreErr.message);
      }
    }

    console.error("verifyPayment failed:", err.message, err.stack);
    return res.status(500).json(new ApiResponse(500, null, err.message));
  }
});

// PATCH /api/orders/:_id/status
export const updateOrderStatus = asyncHandler(async (req, res) => {
  const { _id } = req.params;
  const { orderStatus } = req.body;

  const sanitizedStatus = sanitizeString(orderStatus);

  if (!CONFIG.validStatuses.has(sanitizedStatus)) {
    return res.status(400).json(
      new ApiResponse(
        400,
        null,
        `Invalid status. Use: ${[...CONFIG.validStatuses].join(", ")}`
      )
    );
  }

  const current = await Order.findById(_id, { orderStatus: 1, selectedVegetables: 1 }).lean();
  if (!current)
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));

  if (sanitizedStatus === "cancelled" && current.orderStatus !== "cancelled") {
    try {
      await updateStock(current.selectedVegetables, "restore");
    } catch (err) {
      console.error("Stock restore error");
    }
  }

  const updateFields = { orderStatus: sanitizedStatus };
  if (sanitizedStatus.toLowerCase() === "delivered") {
    updateFields.paymentStatus = "completed";
  }

  const order = await Order.findByIdAndUpdate(_id, updateFields, {
    new: true,
    runValidators: true,
  })
    .populate("customerInfo", "name email mobile phone address city area state")
    .populate({
      path: "selectedBasket",
      populate: { path: "vegetables.vegetable", select: "name" },
    })
    .populate("selectedVegetables.vegetable", "name")
    .lean();

  if (order?.customerInfo?.email) {
    sendInvoiceEmail(order, null, {
      customSubject: `Order Status Update - #${order.orderId}`,
      customMessage: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#0e540b;color:white;padding:20px;text-align:center;"><h1>VegBazar</h1></div>
          <div style="padding:20px;background:#f8f9fa;">
            <h2 style="color:#0e540b;">Order Status Updated</h2>
            <p>Dear ${order.customerInfo.name || "Customer"},</p>
            <p>Your order <strong>#${order.orderId}</strong> status has been updated to:</p>
            <h3 style="color:#e57512;text-transform:uppercase;margin:20px 0;">${sanitizedStatus}</h3>
            <p>Thank you for shopping with VegBazar!</p>
          </div>
          <div style="background:#0e540b;color:white;padding:15px;text-align:center;font-size:12px;">
            <p>Need help? Contact us at info.vegbazar@gmail.com</p>
          </div>
        </div>`,
      emailType: "statusUpdate",
    }).catch(() => {});
  }

  res.json(new ApiResponse(200, order, "Order status updated"));
});

// GET /api/orders/razorpay-key
export const getRazorpayKey = asyncHandler(async (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID)
    return res.status(500).json(new ApiResponse(500, null, "Key not configured"));
  res.json(new ApiResponse(200, { key: process.env.RAZORPAY_KEY_ID }, "Key fetched"));
});

// POST /api/orders/calculate-price
export const calculatePrice = asyncHandler(async (req, res) => {
  const { items, couponCode } = req.body;
  if (!items || !Array.isArray(items) || !items.length)
    throw new ApiError(400, "Items required");
  if (items.length > CONFIG.maxItemsPerOrder)
    throw new ApiError(400, `Maximum ${CONFIG.maxItemsPerOrder} items allowed`);

  for (const item of items) {
    if (!item.vegetableId || !item.weight || !item.quantity || item.quantity < 1)
      throw new ApiError(400, "Invalid item");
    if (item.quantity > CONFIG.maxQuantity)
      throw new ApiError(400, `Maximum quantity is ${CONFIG.maxQuantity}`);
  }

  const ids = items.map((i) => i.vegetableId);
  const vegMap = await fetchVegetablesBatch(ids);

  let subtotal = 0;
  const calculatedItems = [];

  for (const item of items) {
    const veg = vegMap.get(item.vegetableId.toString());
    if (!veg) throw new ApiError(404, `Vegetable not found: ${item.vegetableId}`);

    try {
      const priceInfo = getPrice(veg, item.weight, item.quantity);
      calculatedItems.push({
        vegetableId: item.vegetableId,
        name: veg.name,
        pricingType: veg.pricingType,
        quantity: item.quantity,
        pricePerUnit: priceInfo.pricePerUnit,
        subtotal: priceInfo.subtotal,
        ...(priceInfo.type === "set"
          ? {
              weight: item.weight,
              setLabel: priceInfo.label,
              setQuantity: priceInfo.setQuantity,
              setUnit: priceInfo.setUnit,
            }
          : { weight: priceInfo.weight }),
      });
      subtotal += priceInfo.subtotal;
    } catch (error) {
      throw new ApiError(400, `Error processing ${veg.name}: ${error.message}`);
    }
  }

  let couponDiscount = 0, couponDetails = null;
  if (couponCode) {
    try {
      const v = await validateCoupon(couponCode, subtotal, null);
      couponDiscount = v.couponDiscount;
      couponDetails = v.couponDetails;
    } catch (error) {
      couponDetails = { code: couponCode, applied: false, error: error.message };
    }
  }

  const subtotalAfterDiscount = Math.max(0, subtotal - couponDiscount);
  const freeDelivery = subtotalAfterDiscount > CONFIG.freeDeliveryThreshold;
  const delivery = freeDelivery ? 0 : CONFIG.deliveryCharges;

  res.json(
    new ApiResponse(
      200,
      {
        items: calculatedItems,
        coupon: couponDetails,
        summary: {
          subtotal,
          couponDiscount,
          subtotalAfterDiscount,
          deliveryCharges: delivery,
          freeDelivery,
          totalAmount: subtotalAfterDiscount + delivery,
        },
        timestamp: new Date().toISOString(),
      },
      "Price calculated"
    )
  );
});

// POST /api/orders/validate-coupon-basket
export const validateCouponForBasket = asyncHandler(async (req, res) => {
  const { basketId, basketPrice, couponCode } = req.body;

  if (!basketId || !basketPrice) throw new ApiError(400, "Basket ID and price required");
  if (!couponCode) throw new ApiError(400, "Coupon code required");

  const [basket, coupon] = await Promise.all([
    Basket.findById(basketId).select("price").lean(),
    Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true }).lean(),
  ]);

  if (!basket) throw new ApiError(404, "Basket not found");
  if (basket.price !== basketPrice) throw new ApiError(400, "Basket price mismatch");

  let couponDetails = null;
  let couponDiscount = 0;

  if (!coupon) {
    couponDetails = { code: couponCode, applied: false, error: "Invalid coupon code" };
  } else if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
    couponDetails = { code: couponCode, applied: false, error: "Coupon has expired" };
  } else if (coupon.minOrderAmount && basketPrice < coupon.minOrderAmount) {
    couponDetails = {
      code: couponCode,
      applied: false,
      error: `Minimum order amount of ₹${coupon.minOrderAmount} required`,
    };
  } else if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    couponDetails = { code: couponCode, applied: false, error: "Coupon usage limit reached" };
  } else {
    couponDiscount =
      coupon.discountType === "percentage"
        ? Math.min((basketPrice * coupon.discountValue) / 100, coupon.maxDiscount || Infinity)
        : Math.min(coupon.discountValue, basketPrice);

    couponDetails = {
      code: coupon.code,
      applied: true,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discount: couponDiscount,
    };
  }

  const discountedPrice = Math.max(0, basketPrice - couponDiscount);
  const totalAmount = discountedPrice + CONFIG.deliveryCharges;

  res.json(
    new ApiResponse(
      200,
      {
        coupon: couponDetails,
        pricing: {
          originalPrice: basketPrice,
          couponDiscount,
          discountedPrice,
          deliveryCharges: CONFIG.deliveryCharges,
          totalAmount,
        },
      },
      couponDetails?.applied ? "Coupon applied successfully" : "Coupon validation result"
    )
  );
});

// GET /api/orders/date-range?startDate=&endDate=&startTime=&endTime=
export const getOrdersByDateTimeRange = asyncHandler(async (req, res) => {
  const { startDate, endDate, startTime, endTime } = req.query;

  if (!startDate || !endDate) {
    throw new ApiError(400, "Both startDate and endDate are required (YYYY-MM-DD)");
  }

  const start = new Date(`${startDate}T${startTime || "00:00:00"}`);
  const end = new Date(`${endDate}T${endTime || "23:59:59"}`);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new ApiError(400, "Invalid date format. Use YYYY-MM-DD");
  }

  if (start > end) {
    throw new ApiError(400, "startDate must be before or equal to endDate");
  }

  const orders = await Order.find({
    orderDate: { $gte: start, $lte: end },
  })
    .populate("customerInfo", "name phone")
    .populate("selectedVegetables.vegetable", "name")
    .sort({ orderDate: -1 })
    .lean();

  if (!orders.length) {
    return res.json(
      new ApiResponse(
        200,
        { orders: [], totalOrders: 0, summary: { totalOrders: 0, totalRevenue: 0 }, vegetableData: {} },
        "No orders found in the specified date range"
      )
    );
  }

  const vegDataMap = new Map();
  let totalRevenue = 0, totalWeightKg = 0, totalPieces = 0;

  for (const order of orders) {
    totalRevenue += order.totalAmount || 0;

    for (const item of order.selectedVegetables) {
      const vegName = item.vegetable?.name || "Unknown";
      if (!vegDataMap.has(vegName))
        vegDataMap.set(vegName, { totalWeightKg: 0, totalPieces: 0, totalBundles: 0, orders: 0 });

      const veg = vegDataMap.get(vegName);
      const isSet = item.weight?.startsWith("set");

      if (isSet) {
        const qty = (item.setQuantity || 0) * item.quantity;
        if (item.setUnit === "pieces") veg.totalPieces += qty;
        else if (item.setUnit === "bundles") veg.totalBundles += qty;
        else veg.totalPieces += qty;
      } else {
        veg.totalWeightKg += (CONFIG.weightToKg.get(item.weight) || 0) * item.quantity;
      }
      veg.orders++;
    }
  }

  const vegData = {};
  for (const [vegName, veg] of vegDataMap) {
    veg.totalWeightKg = Math.round(veg.totalWeightKg * 100) / 100;
    totalWeightKg += veg.totalWeightKg;
    totalPieces += veg.totalPieces + veg.totalBundles;
    vegData[vegName] = veg;
  }

  const summary = {
    totalOrders: orders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalVegetablesWeightKg: Math.round(totalWeightKg * 100) / 100,
    totalVegetablesPieces: totalPieces,
    uniqueVegetables: Object.keys(vegData).length,
    dateFrom: startDate,
    dateTo: endDate,
    ...(startTime && { timeFrom: startTime }),
    ...(endTime && { timeTo: endTime }),
  };

  res.json(
    new ApiResponse(200, { summary, vegetableData: vegData, orders }, "Orders retrieved successfully")
  );
});

// GET /api/orders/status?status=placed&startDate=&endDate=
export const getOrdersByStatus = asyncHandler(async (req, res) => {
  const { status, startDate, endDate } = req.query;

  if (!status) throw new ApiError(400, "Status parameter required");

  const normalizedStatus = status.trim().toLowerCase();
  if (!CONFIG.validStatuses.has(normalizedStatus))
    throw new ApiError(400, `Invalid status. Valid values: ${[...CONFIG.validStatuses].join(", ")}`);

  const query = { orderStatus: normalizedStatus };

  if (startDate || endDate) {
    query.orderDate = {};
    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      if (!isNaN(start.getTime())) query.orderDate.$gte = start;
    }
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59`);
      if (!isNaN(end.getTime())) query.orderDate.$lte = end;
    }
  }

  const orders = await Order.find(query)
    .populate("customerInfo", "name phone")
    .populate("selectedVegetables.vegetable", "name")
    .sort({ orderDate: -1 })
    .lean();

  if (!orders.length) {
    return res.json(
      new ApiResponse(
        200,
        { orders: [], totalOrders: 0, summary: { totalOrders: 0, totalRevenue: 0 }, vegetableData: {} },
        `No orders found with status: ${normalizedStatus}`
      )
    );
  }

  const vegDataMap = new Map();
  let totalRevenue = 0, totalWeightKg = 0, totalPieces = 0;

  for (const order of orders) {
    totalRevenue += order.totalAmount || 0;

    for (const item of order.selectedVegetables) {
      const vegName = item.vegetable?.name || "Unknown";
      if (!vegDataMap.has(vegName))
        vegDataMap.set(vegName, { totalWeightKg: 0, totalPieces: 0, totalBundles: 0, orders: 0 });

      const veg = vegDataMap.get(vegName);
      const isSet = item.weight?.startsWith("set");

      if (isSet) {
        const qty = (item.setQuantity || 0) * item.quantity;
        if (item.setUnit === "pieces") veg.totalPieces += qty;
        else if (item.setUnit === "bundles") veg.totalBundles += qty;
        else veg.totalPieces += qty;
      } else {
        veg.totalWeightKg += (CONFIG.weightToKg.get(item.weight) || 0) * item.quantity;
      }
      veg.orders++;
    }
  }

  const vegData = {};
  for (const [vegName, veg] of vegDataMap) {
    veg.totalWeightKg = Math.round(veg.totalWeightKg * 100) / 100;
    totalWeightKg += veg.totalWeightKg;
    totalPieces += veg.totalPieces + veg.totalBundles;
    vegData[vegName] = veg;
  }

  const summary = {
    totalOrders: orders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalVegetablesWeightKg: Math.round(totalWeightKg * 100) / 100,
    totalVegetablesPieces: totalPieces,
    uniqueVegetables: Object.keys(vegData).length,
    status: normalizedStatus,
    ...(startDate && { dateFrom: startDate }),
    ...(endDate && { dateTo: endDate }),
  };

  res.json(
    new ApiResponse(200, { summary, vegetableData: vegData, orders }, `Orders with status '${normalizedStatus}' retrieved`)
  );
});

// GET /api/orders/multi-status?statuses=placed,processed&startDate=&endDate=
export const getOrdersByMultipleStatuses = asyncHandler(async (req, res) => {
  const { statuses, startDate, endDate } = req.query;

  if (!statuses) throw new ApiError(400, "Statuses parameter required");

  const statusSet = new Set(statuses.split(",").map((s) => s.trim().toLowerCase()));
  const validStatuses = Array.from(statusSet).filter((s) => CONFIG.validStatuses.has(s));
  if (!validStatuses.length) throw new ApiError(400, "No valid statuses provided");

  const query = { orderStatus: { $in: validStatuses } };

  if (startDate || endDate) {
    query.orderDate = {};
    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      if (!isNaN(start.getTime())) query.orderDate.$gte = start;
    }
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59`);
      if (!isNaN(end.getTime())) query.orderDate.$lte = end;
    }
  }

  const orders = await Order.find(query)
    .populate("customerInfo", "name")
    .populate("selectedVegetables.vegetable", "name")
    .sort({ orderDate: -1 })
    .lean();

  const ordersByStatusMap = new Map();
  statusSet.forEach((s) => ordersByStatusMap.set(s, []));

  let totalRevenue = 0;
  for (const order of orders) {
    const s = order.orderStatus.toLowerCase();
    if (ordersByStatusMap.has(s)) ordersByStatusMap.get(s).push(order);
    totalRevenue += order.totalAmount || 0;
  }

  const statusCounts = {};
  for (const [s, list] of ordersByStatusMap) statusCounts[s] = list.length;

  res.json(
    new ApiResponse(
      200,
      {
        totalOrders: orders.length,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        statusCounts,
        orders: orders.map((o) => ({
          _id: o._id,
          orderId: o.orderId,
          customerName: o.customerInfo?.name || "Unknown",
          orderDate: o.orderDate,
          totalAmount: o.totalAmount,
          orderStatus: o.orderStatus,
          paymentStatus: o.paymentStatus,
        })),
      },
      "Orders retrieved successfully"
    )
  );
});

// GET /api/orders/stats?startDate=&endDate=
export const getOrderStatusStats = asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  const dateFilter = {};
  if (startDate || endDate) {
    dateFilter.orderDate = {};
    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`);
      if (!isNaN(start.getTime())) dateFilter.orderDate.$gte = start;
    }
    if (endDate) {
      const end = new Date(`${endDate}T23:59:59`);
      if (!isNaN(end.getTime())) dateFilter.orderDate.$lte = end;
    }
  }

  const stats = await Order.aggregate([
    ...(Object.keys(dateFilter).length > 0 ? [{ $match: dateFilter }] : []),
    {
      $group: {
        _id: { $toLower: "$orderStatus" },
        count: { $sum: 1 },
        totalRevenue: { $sum: "$totalAmount" },
        avgOrderValue: { $avg: "$totalAmount" },
      },
    },
    {
      $project: {
        _id: 0,
        status: "$_id",
        count: 1,
        totalRevenue: { $round: ["$totalRevenue", 2] },
        avgOrderValue: { $round: ["$avgOrderValue", 2] },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const overallTotal = stats.reduce(
    (acc, stat) => ({
      totalOrders: acc.totalOrders + stat.count,
      totalRevenue: acc.totalRevenue + stat.totalRevenue,
    }),
    { totalOrders: 0, totalRevenue: 0 }
  );

  res.json(
    new ApiResponse(
      200,
      {
        overallTotal: {
          totalOrders: overallTotal.totalOrders,
          totalRevenue: Math.round(overallTotal.totalRevenue * 100) / 100,
        },
        statusBreakdown: stats,
        ...(startDate && { dateFrom: startDate }),
        ...(endDate && { dateTo: endDate }),
      },
      "Statistics retrieved successfully"
    )
  );
});