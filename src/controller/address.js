import Address from "../Model/address.js";
import User from "../Model/user.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";
import { Query } from "mongoose";

const ADDRESS_TYPES = new Set(["home", "work", "other"]);

const EARTH_RADIUS_KM = 6371;

const DELIVERY_CENTER_COORDS = [72.8777, 19.076];

class LRUCache {
  constructor(maxSize = 100) {
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

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

class PriorityQueue {
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

  isEmpty() {
    return this.heap.length === 0;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[parentIndex].priority <= this.heap[index].priority) break;
      [this.heap[parentIndex], this.heap[index]] = [
        this.heap[index],
        this.heap[parentIndex],
      ];
      index = parentIndex;
    }
  }

  _sinkDown(index) {
    const length = this.heap.length;
    while (true) {
      let left = 2 * index + 1;
      let right = 2 * index + 2;
      let smallest = index;

      if (
        left < length &&
        this.heap[left].priority < this.heap[smallest].priority
      ) {
        smallest = left;
      }
      if (
        right < length &&
        this.heap[right].priority < this.heap[smallest].priority
      ) {
        smallest = right;
      }
      if (smallest === index) break;

      [this.heap[index], this.heap[smallest]] = [
        this.heap[smallest],
        this.heap[index],
      ];
      index = smallest;
    }
  }
}

class BloomFilter {
  constructor(size = 1000, hashCount = 3) {
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

class TrieNode {
  constructor() {
    this.children = {};
    this.isEndOfWord = false;
    this.addresses = [];
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(word, address) {
    let node = this.root;
    for (const char of word.toLowerCase()) {
      if (!node.children[char]) {
        node.children[char] = new TrieNode();
      }
      node = node.children[char];
      node.addresses.push(address);
    }
    node.isEndOfWord = true;
  }

  search(prefix) {
    let node = this.root;
    for (const char of prefix.toLowerCase()) {
      if (!node.children[char]) return [];
      node = node.children[char];
    }
    return node.addresses.slice(0, 10);
  }
}

class SpatialHashGrid {
  constructor(cellSize = 0.01) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  _getCellKey(lng, lat) {
    const cellX = Math.floor(lng / this.cellSize);
    const cellY = Math.floor(lat / this.cellSize);
    return `${cellX},${cellY}`;
  }

  insert(address) {
    const [lng, lat] = address.location.coordinates;
    const key = this._getCellKey(lng, lat);
    if (!this.grid.has(key)) {
      this.grid.set(key, []);
    }
    this.grid.get(key).push(address);
  }

  queryNearby(lng, lat, radiusKm = 5) {
    const results = [];
    const radiusCells = Math.ceil(radiusKm / (this.cellSize * 111));

    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const queryLng = lng + dx * this.cellSize;
        const queryLat = lat + dy * this.cellSize;
        const key = this._getCellKey(queryLng, queryLat);

        const cellAddresses = this.grid.get(key) || [];
        for (const address of cellAddresses) {
          const distance = calculateDistance(
            [lng, lat],
            address.location.coordinates,
          );
          if (distance <= radiusKm) {
            results.push({ address, distance });
          }
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }
}

class DeliveryGraph {
  constructor() {
    this.nodes = new Map();
  }

  addNode(addressId, lng, lat) {
    this.nodes.set(addressId, {
      id: addressId,
      lng,
      lat,
      connections: new Map(),
    });
  }

  addEdge(fromId, toId) {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);

    if (!fromNode || !toNode) return;

    const distance = calculateDistance(
      [fromNode.lng, fromNode.lat],
      [toNode.lng, toNode.lat],
    );

    fromNode.connections.set(toId, distance);
    toNode.connections.set(fromId, distance);
  }

  findShortestPath(startId, endId) {
    const distances = new Map();
    const previous = new Map();
    const unvisited = new PriorityQueue();
    for (const [nodeId] of this.nodes) {
      distances.set(nodeId, nodeId === startId ? 0 : Infinity);
      unvisited.enqueue(nodeId, nodeId === startId ? 0 : Infinity);
    }

    while (!unvisited.isEmpty()) {
      const { item: currentId } = unvisited.dequeue();

      if (currentId === endId) break;
      if (distances.get(currentId) === Infinity) break;

      const currentNode = this.nodes.get(currentId);
      for (const [neighborId, edgeDistance] of currentNode.connections) {
        const alt = distances.get(currentId) + edgeDistance;
        if (alt < distances.get(neighborId)) {
          distances.set(neighborId, alt);
          previous.set(neighborId, currentId);
          unvisited.enqueue(neighborId, alt);
        }
      }
    }
    const path = [];
    let current = endId;
    while (current) {
      path.unshift(current);
      current = previous.get(current);
    }

    return {
      path,
      distance: distances.get(endId),
      found: distances.get(endId) !== Infinity,
    };
  }
}

const deliveryChargesCache = new LRUCache(500);

const addressBloomFilter = new BloomFilter(10000, 5);

const addressTrie = new Trie();

const spatialGrid = new SpatialHashGrid();

const deliveryGraph = new DeliveryGraph();

const userAddressMap = new Map();

const calculateDistance = (coord1, coord2) => {
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

const calculateDeliveryCharges = (distance, addressSettings = {}) => {
  const {
    baseCharge = 2000,
    perKmCharge = 500,
    freeThreshold = 5,
    minCharge = 1000,
    maxCharge = 10000,
  } = addressSettings;

  let totalCharge = baseCharge;

  if (distance > freeThreshold) {
    const distanceCharge = (distance - freeThreshold) * perKmCharge;
    totalCharge += distanceCharge;
  }
  totalCharge = Math.max(minCharge, totalCharge);
  totalCharge = Math.min(maxCharge, totalCharge);

  return {
    baseCharge,
    distanceCharge: totalCharge - baseCharge,
    totalCharge,
    distance,
    breakdown: {
      freeThreshold,
      perKmCharge,
      applicableDistance: Math.max(0, distance - freeThreshold),
    },
  };
};

// GET ALL ADDRESSES - FIXED: Remove .populate("user")
export const getAddresses = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const {
    type,
    isActive,
    isDefault,
    sortBy = "createdAt",
    sortOrder = "desc",
    page = 1,
    limit = 50,
  } = req.query;

  // Build query
  const query = { user: userId };
  if (type && ADDRESS_TYPES.has(type)) query.type = type;
  if (isActive !== undefined) query.isActive = isActive === "true";
  if (isDefault !== undefined) query.isDefault = isDefault === "true";

  // Get total count for pagination
  const total = await Address.countDocuments(query);

  // Fetch addresses with lean for better performance
  const addresses = await Address.find(query)
    .lean()
    .limit(parseInt(limit))
    .skip((parseInt(page) - 1) * parseInt(limit));

  // Sort using priority queue for complex sorting
  const pq = new PriorityQueue();
  addresses.forEach((address) => {
    let priority = 0;
    switch (sortBy) {
      case "distance":
        priority = address.distance || 0;
        break;
      case "deliveryCharges":
        const cacheKey = `charges_${address._id}`;
        const cachedCharges = deliveryChargesCache.get(cacheKey);
        priority = cachedCharges
          ? cachedCharges.totalCharge
          : address.deliveryCharges || 0;
        break;
      case "createdAt":
      default:
        priority = new Date(address.createdAt).getTime();
        break;
    }
    pq.enqueue(address, sortOrder === "desc" ? -priority : priority);
  });

  const sortedAddresses = [];
  while (!pq.isEmpty()) {
    sortedAddresses.push(pq.dequeue().item);
  }

  // Add delivery charges to each address
  const addressesWithCharges = await Promise.all(
    sortedAddresses.map(async (address) => {
      const cacheKey = `charges_${address._id}`;
      let charges = deliveryChargesCache.get(cacheKey);

      if (!charges) {
        charges = await Address.getDeliveryCharges(address._id);
        deliveryChargesCache.set(cacheKey, charges);
      }

      return {
        ...address,
        deliveryCharges: charges,
      };
    }),
  );

  res.status(200).json(
    new ApiResponse(
      200,
      {
        addresses: addressesWithCharges,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / parseInt(limit)),
        },
        defaultAddress: addressesWithCharges.find((addr) => addr.isDefault),
        cacheStats: {
          chargesCacheSize: deliveryChargesCache.size(),
        },
      },
      "Addresses retrieved successfully",
    ),
  );
});

// NEW: Get all addresses without any filters (simpler endpoint)
export const getAllUserAddresses = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Fetch ALL addresses for this user
  const addresses = await Address.find({ user: userId })
    .sort({ isDefault: -1, createdAt: -1 }) // Default first, then by creation date
    .lean();

  // Add delivery charges in parallel
  const addressesWithCharges = await Promise.all(
    addresses.map(async (address) => {
      const cacheKey = `charges_${address._id}`;
      let charges = deliveryChargesCache.get(cacheKey);

      if (!charges) {
        charges = await Address.getDeliveryCharges(address._id);
        deliveryChargesCache.set(cacheKey, charges);
      }

      return {
        ...address,
        deliveryCharges: charges,
      };
    }),
  );

  res.status(200).json(
    new ApiResponse(
      200,
      {
        userId,
        addresses: addressesWithCharges,
        total: addressesWithCharges.length,
        activeCount: addressesWithCharges.filter((addr) => addr.isActive)
          .length,
        defaultAddress: addressesWithCharges.find((addr) => addr.isDefault),
      },
      `Retrieved ${addressesWithCharges.length} addresses for user`,
    ),
  );
});

// NEW: Get user's active addresses only (most common use case)
export const getActiveAddresses = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const addresses = await Address.find({
    user: userId,
    isActive: true,
  })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  const addressesWithCharges = await Promise.all(
    addresses.map(async (address) => {
      const cacheKey = `charges_${address._id}`;
      let charges = deliveryChargesCache.get(cacheKey);

      if (!charges) {
        charges = await Address.getDeliveryCharges(address._id);
        deliveryChargesCache.set(cacheKey, charges);
      }

      return {
        ...address,
        deliveryCharges: charges,
      };
    }),
  );

  res.status(200).json(
    new ApiResponse(
      200,
      {
        userId,
        addresses: addressesWithCharges,
        total: addressesWithCharges.length,
        defaultAddress: addressesWithCharges.find((addr) => addr.isDefault),
      },
      "Active addresses retrieved successfully",
    ),
  );
});

// NEW: Get addresses by specific user ID (admin use case)
export const getAddressesByUserId = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const requestingUserId = req.user.id;

  // Optional: Check if requesting user has admin privileges
  // if (!req.user.isAdmin && requestingUserId !== userId) {
  //   throw new ApiError(403, "Unauthorized to view other user's addresses");
  // }

  const addresses = await Address.find({ user: userId })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  if (!addresses.length) {
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          userId,
          addresses: [],
          total: 0,
        },
        "No addresses found for this user",
      ),
    );
  }

  const addressesWithCharges = await Promise.all(
    addresses.map(async (address) => {
      const cacheKey = `charges_${address._id}`;
      let charges = deliveryChargesCache.get(cacheKey);

      if (!charges) {
        charges = await Address.getDeliveryCharges(address._id);
        deliveryChargesCache.set(cacheKey, charges);
      }

      return {
        ...address,
        deliveryCharges: charges,
      };
    }),
  );

  res.status(200).json(
    new ApiResponse(
      200,
      {
        userId,
        addresses: addressesWithCharges,
        total: addressesWithCharges.length,
        activeCount: addressesWithCharges.filter((addr) => addr.isActive)
          .length,
        defaultAddress: addressesWithCharges.find((addr) => addr.isDefault),
      },
      "User addresses retrieved successfully",
    ),
  );
});
// ADD ADDRESS - FIXED: Remove .populate("user")
export const addAddress = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const {
    type,
    street,
    area,
    city,
    state,
    pincode,
    country = "India",
    coordinates,
    isDefault = false,
  } = req.body;

  if (!street || !city || !state || !pincode) {
    throw new ApiError(400, "Street, city, state, and pincode are required");
  }

  if (type && !ADDRESS_TYPES.has(type)) {
    throw new ApiError(400, "Invalid address type. Use: home, work, or other");
  }

  const addressSignature =
    `${street}|${area || ""}|${city}|${state}|${pincode}`.toLowerCase();
  if (addressBloomFilter.mightContain(addressSignature)) {
    const existingAddress = await Address.findOne({
      user: userId,
      street: new RegExp(`^${street.trim()}$`, "i"),
      city: new RegExp(`^${city.trim()}$`, "i"),
      pincode: pincode.trim(),
    });

    if (existingAddress) {
      throw new ApiError(409, "Similar address already exists");
    }
  }

  // Check if this is the user's first address
  const existingAddressCount = await Address.countDocuments({
    user: userId,
    isActive: true,
  });

  // If it's the first address OR isDefault is explicitly true, make it default
  const shouldBeDefault = existingAddressCount === 0 || isDefault === true;

  // If setting as default, unset other defaults
  if (shouldBeDefault) {
    await Address.updateMany(
      { user: userId, isDefault: true },
      { isDefault: false },
    );
  }

  let distance = 0;
  let location = { type: "Point", coordinates: [0, 0] };

  if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
    distance = calculateDistance(coordinates, DELIVERY_CENTER_COORDS);
    location.coordinates = coordinates;
  }

  // Create address
  const address = new Address({
    user: userId,
    type: type || "home",
    street: street.trim(),
    area: area?.trim(),
    city: city.trim(),
    state: state.trim(),
    pincode: pincode.trim(),
    country: country.trim(),
    location,
    distance,
    isDefault: shouldBeDefault,
  });

  await address.save();

  // Push address ID to user's addresses array
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  user.addresses.push(address._id);

  // Set as default address if it's the first address or explicitly marked as default
  if (shouldBeDefault) {
    user.defaultAddress = address._id;
  }

  await user.save();

  addressBloomFilter.add(addressSignature);
  spatialGrid.insert(address);
  addressTrie.insert(address.fullAddress, address);

  if (!userAddressMap.has(userId)) {
    userAddressMap.set(userId, new Set());
  }
  userAddressMap.get(userId).add(address._id.toString());

  deliveryGraph.addNode(address._id.toString(), ...location.coordinates);

  const charges = await Address.getDeliveryCharges(address._id);
  deliveryChargesCache.set(`charges_${address._id}`, charges);

  // FIXED: Get saved address without populating user
  const savedAddress = await Address.findById(address._id).lean();

  res.status(201).json(
    new ApiResponse(
      201,
      {
        address: {
          ...savedAddress,
          deliveryCharges: charges,
        },
      },
      "Address added successfully",
    ),
  );
});

// UPDATE ADDRESS - FIXED: Remove .populate("user")
export const updateAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;
  const {
    type,
    street,
    area,
    city,
    state,
    pincode,
    country,
    coordinates,
    isDefault,
    isActive,
  } = req.body;

  // FIXED: Removed .populate("user")
  const address = await Address.findOne({
    _id: addressId,
    user: userId,
  });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  if (type && !ADDRESS_TYPES.has(type)) {
    throw new ApiError(400, "Invalid address type. Use: home, work, or other");
  }

  // If setting as default, unset other defaults
  if (isDefault === true) {
    await Address.updateMany(
      { user: userId, isDefault: true, _id: { $ne: addressId } },
      { isDefault: false },
    );
  }

  if (type !== undefined) address.type = type;
  if (street !== undefined) address.street = street.trim();
  if (area !== undefined) address.area = area?.trim();
  if (city !== undefined) address.city = city.trim();
  if (state !== undefined) address.state = state.trim();
  if (pincode !== undefined) address.pincode = pincode.trim();
  if (country !== undefined) address.country = country.trim();
  if (isDefault !== undefined) address.isDefault = isDefault;
  if (isActive !== undefined) address.isActive = isActive;

  if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
    address.distance = calculateDistance(coordinates, DELIVERY_CENTER_COORDS);
    address.location.coordinates = coordinates;
  }

  await address.save();

  // FIXED: Get updated address without populating user
  const updatedAddress = await Address.findById(addressId).lean();
  const charges = await Address.getDeliveryCharges(address._id);

  // Clear cache for this address
  deliveryChargesCache.set(`charges_${address._id}`, charges);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        address: {
          ...updatedAddress,
          deliveryCharges: charges,
        },
      },
      "Address updated successfully",
    ),
  );
});

// SET DEFAULT ADDRESS - FIXED: Remove .populate("user")
export const setDefaultAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  // FIXED: Removed .populate("user")
  const address = await Address.findOne({
    _id: addressId,
    user: userId,
  });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  // Unset all other defaults first
  await Address.updateMany(
    { user: userId, _id: { $ne: addressId } },
    { isDefault: false },
  );

  // Set this address as default
  address.isDefault = true;
  await address.save();

  // Update user's defaultAddress field
  const user = await User.findById(userId);
  if (user) {
    user.defaultAddress = addressId;
    await user.save();
  }

  // FIXED: Get address without populating user
  const updatedAddress = await Address.findById(addressId).lean();
  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        address: {
          ...updatedAddress,
          deliveryCharges: charges,
        },
      },
      "Default address set successfully",
    ),
  );
});

// DELETE ADDRESS - FIXED: Remove .populate("user")
export const deleteAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  // FIXED: Removed .populate("user")
  const address = await Address.findOne({
    _id: addressId,
    user: userId,
  });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  const otherAddresses = await Address.countDocuments({
    user: userId,
    _id: { $ne: addressId },
    isActive: true,
  });

  if (otherAddresses === 0) {
    throw new ApiError(
      400,
      "Cannot delete the only active address. Add another address first.",
    );
  }

  await Address.findByIdAndDelete(addressId);

  // Remove address ID from user's addresses array
  const user = await User.findById(userId);
  if (user) {
    user.addresses = user.addresses.filter(
      (id) => id.toString() !== addressId.toString(),
    );

    // If this was the default address, set a new one
    if (
      user.defaultAddress &&
      user.defaultAddress.toString() === addressId.toString()
    ) {
      user.defaultAddress =
        user.addresses.length > 0 ? user.addresses[0] : null;

      // Update the new default address in the Address collection
      if (user.defaultAddress) {
        await Address.findByIdAndUpdate(user.defaultAddress, {
          isDefault: true,
        });
      }
    }

    await user.save();
  }

  res
    .status(200)
    .json(new ApiResponse(200, null, "Address deleted successfully"));
});

// GET DELIVERY CHARGES - FIXED: Remove .populate("user")
export const getDeliveryCharges = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  // FIXED: Removed .populate("user")
  const address = await Address.findOne({
    _id: addressId,
    user: userId,
  }).lean();

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        deliveryCharges: charges,
        address: {
          id: address._id,
          distance: address.distance,
          location: address.location,
        },
      },
      "Delivery charges calculated successfully",
    ),
  );
});

// UPDATE ADDRESS LOCATION - FIXED: Remove .populate("user")
export const updateAddressLocation = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;
  const { coordinates } = req.body;

  if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new ApiError(
      400,
      "Valid coordinates [longitude, latitude] are required",
    );
  }

  // FIXED: Removed .populate("user")
  const address = await Address.findOne({
    _id: addressId,
    user: userId,
  });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  const distance = calculateDistance(coordinates, DELIVERY_CENTER_COORDS);

  address.location.coordinates = coordinates;
  address.distance = distance;
  address.lastDistanceUpdate = new Date();

  await address.save();

  // FIXED: Get updated address without populating user
  const updatedAddress = await Address.findById(addressId).lean();
  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        address: {
          ...updatedAddress,
          deliveryCharges: charges,
        },
      },
      "Address location updated successfully",
    ),
  );
});

// GET NEARBY ADDRESSES - No changes needed (no user population)
export const getNearbyAddresses = asyncHandler(async (req, res) => {
  const { lng, lat, radius = 10 } = req.query;

  if (!lng || !lat) {
    throw new ApiError(400, "Longitude and latitude are required");
  }

  const centerCoords = [parseFloat(lng), parseFloat(lat)];
  const radiusKm = parseFloat(radius);
  const nearbyResults = spatialGrid.queryNearby(
    parseFloat(lng),
    parseFloat(lat),
    radiusKm,
  );

  const limitedResults = nearbyResults.slice(0, 50);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        addresses: limitedResults,
        center: centerCoords,
        radius: radiusKm,
        count: limitedResults.length,
        performance: {
          spatialGridHits: limitedResults.length,
          totalPossible: nearbyResults.length,
        },
      },
      "Nearby addresses retrieved successfully",
    ),
  );
});

// AUTOCOMPLETE ADDRESSES - No changes needed (Trie already has addresses)
export const autocompleteAddresses = asyncHandler(async (req, res) => {
  const { query, limit = 10 } = req.query;
  const userId = req.user.id;

  if (!query || query.length < 2) {
    return res.status(200).json(
      new ApiResponse(
        200,
        {
          addresses: [],
          query: query || "",
        },
        "Query too short for autocomplete",
      ),
    );
  }

  const allMatches = addressTrie.search(query);
  const userMatches = allMatches
    .filter((address) => address.user.toString() === userId)
    .slice(0, parseInt(limit));

  const addressesWithCharges = await Promise.all(
    userMatches.map(async (address) => {
      const cacheKey = `charges_${address._id}`;
      let charges = deliveryChargesCache.get(cacheKey);

      if (!charges) {
        charges = await Address.getDeliveryCharges(address._id);
        deliveryChargesCache.set(cacheKey, charges);
      }

      return {
        ...address,
        deliveryCharges: charges,
      };
    }),
  );

  res.status(200).json(
    new ApiResponse(
      200,
      {
        addresses: addressesWithCharges,
        query,
        totalMatches: userMatches.length,
        trieStats: {
          totalIndexedAddresses: addressTrie.root.addresses?.length || 0,
        },
      },
      "Address autocomplete results",
    ),
  );
});

// OPTIMIZE DELIVERY ROUTE - FIXED: Remove .populate("user")
export const optimizeDeliveryRoute = asyncHandler(async (req, res) => {
  const { addressIds, startAddressId } = req.body;

  if (!addressIds || !Array.isArray(addressIds) || addressIds.length < 2) {
    throw new ApiError(
      400,
      "At least 2 address IDs required for route optimization",
    );
  }

  // FIXED: Removed .populate("user")
  const addresses = await Address.find({ _id: { $in: addressIds } }).lean();

  addresses.forEach((addr) => {
    deliveryGraph.addNode(
      addr._id.toString(),
      addr.location.coordinates[0],
      addr.location.coordinates[1],
    );
  });

  for (let i = 0; i < addresses.length; i++) {
    for (let j = i + 1; j < addresses.length; j++) {
      deliveryGraph.addEdge(
        addresses[i]._id.toString(),
        addresses[j]._id.toString(),
      );
    }
  }

  const route = [startAddressId || addressIds[0]];
  const remaining = new Set(addressIds.filter((id) => id !== route[0]));

  while (remaining.size > 0) {
    const currentId = route[route.length - 1];
    let nearestId = null;
    let minDistance = Infinity;

    for (const id of remaining) {
      const path = deliveryGraph.findShortestPath(currentId, id);
      if (path.found && path.distance < minDistance) {
        minDistance = path.distance;
        nearestId = id;
      }
    }

    if (nearestId) {
      route.push(nearestId);
      remaining.delete(nearestId);
    } else {
      break;
    }
  }

  let totalDistance = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const path = deliveryGraph.findShortestPath(route[i], route[i + 1]);
    if (path.found) {
      totalDistance += path.distance;
    }
  }

  res.status(200).json(
    new ApiResponse(
      200,
      {
        optimizedRoute: route,
        totalDistance,
        addressCount: route.length,
        algorithm: "Nearest Neighbor (Greedy)",
        graphStats: {
          nodes: deliveryGraph.nodes.size,
          edges:
            Array.from(deliveryGraph.nodes.values()).reduce(
              (sum, node) => sum + node.connections.size,
              0,
            ) / 2,
        },
      },
      "Delivery route optimized successfully",
    ),
  );
});

// GET ADDRESS ANALYTICS - FIXED: Remove .populate("user")
export const getAddressAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // FIXED: Removed .populate("user")
  const addresses = await Address.find({ user: userId }).lean();

  const analytics = {
    totalAddresses: addresses.length,
    addressTypes: {},
    distanceStats: {
      min: Infinity,
      max: 0,
      avg: 0,
      total: 0,
    },
    deliveryChargeStats: {
      min: Infinity,
      max: 0,
      avg: 0,
      total: 0,
    },
    cities: new Set(),
    states: new Set(),
  };

  addresses.forEach((address) => {
    analytics.addressTypes[address.type] =
      (analytics.addressTypes[address.type] || 0) + 1;

    if (address.distance < analytics.distanceStats.min)
      analytics.distanceStats.min = address.distance;
    if (address.distance > analytics.distanceStats.max)
      analytics.distanceStats.max = address.distance;
    analytics.distanceStats.total += address.distance;

    const charges =
      deliveryChargesCache.get(`charges_${address._id}`)?.totalCharge ||
      address.deliveryCharges ||
      0;
    if (charges < analytics.deliveryChargeStats.min)
      analytics.deliveryChargeStats.min = charges;
    if (charges > analytics.deliveryChargeStats.max)
      analytics.deliveryChargeStats.max = charges;
    analytics.deliveryChargeStats.total += charges;

    analytics.cities.add(address.city);
    analytics.states.add(address.state);
  });

  if (addresses.length > 0) {
    analytics.distanceStats.avg =
      analytics.distanceStats.total / addresses.length;
    analytics.deliveryChargeStats.avg =
      analytics.deliveryChargeStats.total / addresses.length;
  } else {
    analytics.distanceStats.min = 0;
    analytics.deliveryChargeStats.min = 0;
  }

  analytics.cities = Array.from(analytics.cities);
  analytics.states = Array.from(analytics.states);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        analytics,
        dsaPerformance: {
          cacheHitRate:
            deliveryChargesCache.size() / Math.max(addresses.length, 1),
          bloomFilterSize: addressBloomFilter.size,
          spatialGridCells: spatialGrid.grid.size,
          trieNodes: addressTrie.root.children
            ? Object.keys(addressTrie.root.children).length
            : 0,
        },
      },
      "Address analytics retrieved successfully",
    ),
  );
});
