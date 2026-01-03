import Address from "../Model/address.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import { ApiResponse } from "../utility/ApiResponse.js";
import { ApiError } from "../utility/ApiError.js";

// ============= ADVANCED DATA STRUCTURES FOR PERFORMANCE =============

// Address type validation set - O(1) lookup
const ADDRESS_TYPES = new Set(["home", "work", "other"]);

// Distance calculation constants
const EARTH_RADIUS_KM = 6371; // Earth's radius in kilometers

// Cache for delivery center coordinates (can be set from environment)
const DELIVERY_CENTER_COORDS = [72.8777, 19.0760]; // Default: Mumbai coordinates [lng, lat]

// ============= ADVANCED DSA IMPLEMENTATIONS =============

// LRU Cache for delivery charges - O(1) access
class LRUCache {
  constructor(maxSize = 100) {
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
      // Remove least recently used (first item)
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

// Priority Queue for address sorting by distance/delivery time
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

// Bloom Filter for duplicate address detection
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

// Trie for address autocomplete
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
    return node.addresses.slice(0, 10); // Return top 10 matches
  }
}

// Spatial Hash Grid for efficient geospatial queries
class SpatialHashGrid {
  constructor(cellSize = 0.01) { // ~1km cells
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
    const radiusCells = Math.ceil(radiusKm / (this.cellSize * 111)); // Rough km conversion

    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dy = -radiusCells; dy <= radiusCells; dy++) {
        const queryLng = lng + dx * this.cellSize;
        const queryLat = lat + dy * this.cellSize;
        const key = this._getCellKey(queryLng, queryLat);

        const cellAddresses = this.grid.get(key) || [];
        for (const address of cellAddresses) {
          const distance = calculateDistance([lng, lat], address.location.coordinates);
          if (distance <= radiusKm) {
            results.push({ address, distance });
          }
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }
}

// Graph for delivery route optimization
class DeliveryGraph {
  constructor() {
    this.nodes = new Map(); // addressId -> {lng, lat, connections}
  }

  addNode(addressId, lng, lat) {
    this.nodes.set(addressId, {
      id: addressId,
      lng,
      lat,
      connections: new Map() // connectedAddressId -> distance
    });
  }

  addEdge(fromId, toId) {
    const fromNode = this.nodes.get(fromId);
    const toNode = this.nodes.get(toId);

    if (!fromNode || !toNode) return;

    const distance = calculateDistance(
      [fromNode.lng, fromNode.lat],
      [toNode.lng, toNode.lat]
    );

    fromNode.connections.set(toId, distance);
    toNode.connections.set(fromId, distance); // Undirected graph
  }

  // Dijkstra's algorithm for shortest path
  findShortestPath(startId, endId) {
    const distances = new Map();
    const previous = new Map();
    const unvisited = new PriorityQueue();

    // Initialize
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

    // Reconstruct path
    const path = [];
    let current = endId;
    while (current) {
      path.unshift(current);
      current = previous.get(current);
    }

    return {
      path,
      distance: distances.get(endId),
      found: distances.get(endId) !== Infinity
    };
  }
}

// ============= GLOBAL DSA INSTANCES =============

// LRU Cache for delivery charges (max 500 entries)
const deliveryChargesCache = new LRUCache(500);

// Bloom Filter for duplicate address detection
const addressBloomFilter = new BloomFilter(10000, 5);

// Trie for address autocomplete
const addressTrie = new Trie();

// Spatial Hash Grid for geospatial queries
const spatialGrid = new SpatialHashGrid();

// Delivery Graph for route optimization
const deliveryGraph = new DeliveryGraph();

// Hash Map for fast address lookups by user
const userAddressMap = new Map(); // userId -> Set of addressIds

// ============= UTILITY FUNCTIONS =============

// Calculate distance between two coordinates using Haversine formula
const calculateDistance = (coord1, coord2) => {
  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return EARTH_RADIUS_KM * c;
};

// Calculate delivery charges based on distance
const calculateDeliveryCharges = (distance, addressSettings = {}) => {
  const {
    baseCharge = 2000, // ₹20
    perKmCharge = 500, // ₹5 per km
    freeThreshold = 5, // 5km free
    minCharge = 1000, // ₹10 minimum
    maxCharge = 10000 // ₹100 maximum
  } = addressSettings;

  let totalCharge = baseCharge;

  if (distance > freeThreshold) {
    const distanceCharge = (distance - freeThreshold) * perKmCharge;
    totalCharge += distanceCharge;
  }

  // Apply min/max constraints
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
      applicableDistance: Math.max(0, distance - freeThreshold)
    }
  };
};

// ============= ADDRESS CONTROLLERS =============

// Get all addresses for current user
export const getAddresses = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { type, isActive = true, isDefault, sortBy = "createdAt", sortOrder = "desc" } = req.query;

  // Build query with optimized indexing
  const query = { user: userId };
  if (type) query.type = type;
  if (isActive !== undefined) query.isActive = isActive === 'true';
  if (isDefault !== undefined) query.isDefault = isDefault === 'true';

  // Use Priority Queue for custom sorting
  const addresses = await Address.find(query).lean();
  const pq = new PriorityQueue();

  addresses.forEach(address => {
    let priority = 0;
    switch (sortBy) {
      case "distance":
        priority = address.distance || 0;
        break;
      case "deliveryCharges":
        // Use cached charges or calculate
        const cacheKey = `charges_${address._id}`;
        const cachedCharges = deliveryChargesCache.get(cacheKey);
        priority = cachedCharges ? cachedCharges.totalCharge : address.deliveryCharges || 0;
        break;
      case "createdAt":
      default:
        priority = new Date(address.createdAt).getTime();
        break;
    }
    pq.enqueue(address, sortOrder === "desc" ? -priority : priority);
  });

  // Extract sorted addresses
  const sortedAddresses = [];
  while (!pq.isEmpty()) {
    sortedAddresses.push(pq.dequeue().item);
  }

  // Get delivery charges with caching
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
        deliveryCharges: charges
      };
    })
  );

  res.status(200).json(
    new ApiResponse(200, {
      addresses: addressesWithCharges,
      total: addressesWithCharges.length,
      defaultAddress: addressesWithCharges.find(addr => addr.isDefault),
      cacheStats: {
        chargesCacheSize: deliveryChargesCache.size()
      }
    }, "Addresses retrieved successfully")
  );
});

// Get single address by ID
export const getAddressById = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  const address = await Address.findOne({ _id: addressId, user: userId });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(200, {
      address: {
        ...address.toObject(),
        deliveryCharges: charges
      }
    }, "Address retrieved successfully")
  );
});

// Add new address
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
    isDefault = false
  } = req.body;

  // Validation
  if (!street || !city || !state || !pincode) {
    throw new ApiError(400, "Street, city, state, and pincode are required");
  }

  if (type && !ADDRESS_TYPES.has(type)) {
    throw new ApiError(400, "Invalid address type. Use: home, work, or other");
  }

  // Create address signature for duplicate detection
  const addressSignature = `${street}|${area || ""}|${city}|${state}|${pincode}`.toLowerCase();

  // Check for potential duplicates using Bloom Filter
  if (addressBloomFilter.mightContain(addressSignature)) {
    // Do a more thorough check with database
    const existingAddress = await Address.findOne({
      user: userId,
      street: new RegExp(`^${street.trim()}$`, 'i'),
      city: new RegExp(`^${city.trim()}$`, 'i'),
      pincode: pincode.trim()
    });

    if (existingAddress) {
      throw new ApiError(409, "Similar address already exists");
    }
  }

  // If setting as default, unset other defaults
  if (isDefault) {
    await Address.updateMany(
      { user: userId, isDefault: true },
      { isDefault: false }
    );
  }

  // Calculate distance if coordinates provided
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
    isDefault
  });

  await address.save();

  // Update DSA structures
  addressBloomFilter.add(addressSignature);
  spatialGrid.insert(address);
  addressTrie.insert(address.fullAddress, address);

  // Update user address map
  if (!userAddressMap.has(userId)) {
    userAddressMap.set(userId, new Set());
  }
  userAddressMap.get(userId).add(address._id.toString());

  // Add to delivery graph
  deliveryGraph.addNode(address._id.toString(), ...location.coordinates);

  const charges = await Address.getDeliveryCharges(address._id);

  // Cache the charges
  deliveryChargesCache.set(`charges_${address._id}`, charges);

  res.status(201).json(
    new ApiResponse(201, {
      address: {
        ...address.toObject(),
        deliveryCharges: charges
      }
    }, "Address added successfully")
  );
});

// Update address
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
    isActive
  } = req.body;

  const address = await Address.findOne({ _id: addressId, user: userId });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  // Validation
  if (type && !ADDRESS_TYPES.has(type)) {
    throw new ApiError(400, "Invalid address type. Use: home, work, or other");
  }

  // If setting as default, unset other defaults
  if (isDefault) {
    await Address.updateMany(
      { user: userId, isDefault: true },
      { isDefault: false }
    );
  }

  // Update fields
  if (type !== undefined) address.type = type;
  if (street !== undefined) address.street = street.trim();
  if (area !== undefined) address.area = area?.trim();
  if (city !== undefined) address.city = city.trim();
  if (state !== undefined) address.state = state.trim();
  if (pincode !== undefined) address.pincode = pincode.trim();
  if (country !== undefined) address.country = country.trim();
  if (isDefault !== undefined) address.isDefault = isDefault;
  if (isActive !== undefined) address.isActive = isActive;

  // Update coordinates and distance if provided
  if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
    address.distance = calculateDistance(coordinates, DELIVERY_CENTER_COORDS);
    address.location.coordinates = coordinates;
  }

  await address.save();

  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(200, {
      address: {
        ...address.toObject(),
        deliveryCharges: charges
      }
    }, "Address updated successfully")
  );
});

// Delete address
export const deleteAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  const address = await Address.findOne({ _id: addressId, user: userId });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  // Check if user has other addresses
  const otherAddresses = await Address.countDocuments({
    user: userId,
    _id: { $ne: addressId },
    isActive: true
  });

  if (otherAddresses === 0) {
    throw new ApiError(400, "Cannot delete the only active address. Add another address first.");
  }

  await Address.findByIdAndDelete(addressId);

  res.status(200).json(
    new ApiResponse(200, null, "Address deleted successfully")
  );
});

// Set default address
export const setDefaultAddress = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  const address = await Address.findOne({ _id: addressId, user: userId });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  // Unset all defaults and set the selected one
  await Address.updateMany(
    { user: userId },
    { isDefault: false }
  );

  address.isDefault = true;
  await address.save();

  res.status(200).json(
    new ApiResponse(200, {
      address: address.toObject()
    }, "Default address set successfully")
  );
});

// Calculate delivery charges for an address
export const getDeliveryCharges = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;

  const address = await Address.findOne({ _id: addressId, user: userId });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(200, {
      deliveryCharges: charges,
      address: {
        id: address._id,
        distance: address.distance,
        location: address.location
      }
    }, "Delivery charges calculated successfully")
  );
});

// Update address coordinates and recalculate distance
export const updateAddressLocation = asyncHandler(async (req, res) => {
  const { addressId } = req.params;
  const userId = req.user.id;
  const { coordinates } = req.body;

  if (!coordinates || !Array.isArray(coordinates) || coordinates.length !== 2) {
    throw new ApiError(400, "Valid coordinates [longitude, latitude] are required");
  }

  const address = await Address.findOne({ _id: addressId, user: userId });

  if (!address) {
    throw new ApiError(404, "Address not found");
  }

  const distance = calculateDistance(coordinates, DELIVERY_CENTER_COORDS);

  address.location.coordinates = coordinates;
  address.distance = distance;
  address.lastDistanceUpdate = new Date();

  await address.save();

  const charges = await Address.getDeliveryCharges(address._id);

  res.status(200).json(
    new ApiResponse(200, {
      address: {
        ...address.toObject(),
        deliveryCharges: charges
      }
    }, "Address location updated successfully")
  );
});

// Get nearby addresses (admin utility)
export const getNearbyAddresses = asyncHandler(async (req, res) => {
  const { lng, lat, radius = 10 } = req.query;

  if (!lng || !lat) {
    throw new ApiError(400, "Longitude and latitude are required");
  }

  const centerCoords = [parseFloat(lng), parseFloat(lat)];
  const radiusKm = parseFloat(radius);

  // Use Spatial Hash Grid for efficient nearby search
  const nearbyResults = spatialGrid.queryNearby(parseFloat(lng), parseFloat(lat), radiusKm);

  // Limit results for performance
  const limitedResults = nearbyResults.slice(0, 50);

  res.status(200).json(
    new ApiResponse(200, {
      addresses: limitedResults,
      center: centerCoords,
      radius: radiusKm,
      count: limitedResults.length,
      performance: {
        spatialGridHits: limitedResults.length,
        totalPossible: nearbyResults.length
      }
    }, "Nearby addresses retrieved successfully")
  );
});

// Address autocomplete using Trie
export const autocompleteAddresses = asyncHandler(async (req, res) => {
  const { query, limit = 10 } = req.query;
  const userId = req.user.id;

  if (!query || query.length < 2) {
    return res.status(200).json(
      new ApiResponse(200, {
        addresses: [],
        query: query || ""
      }, "Query too short for autocomplete")
    );
  }

  // Search using Trie
  const allMatches = addressTrie.search(query);

  // Filter by user and limit results
  const userMatches = allMatches
    .filter(address => address.user.toString() === userId)
    .slice(0, parseInt(limit));

  // Get delivery charges for matched addresses
  const addressesWithCharges = await Promise.all(
    userMatches.map(async (address) => {
      const cacheKey = `charges_${address._id}`;
      let charges = deliveryChargesCache.get(cacheKey);

      if (!charges) {
        charges = await Address.getDeliveryCharges(address._id);
        deliveryChargesCache.set(cacheKey, charges);
      }

      return {
        ...address.toObject(),
        deliveryCharges: charges
      };
    })
  );

  res.status(200).json(
    new ApiResponse(200, {
      addresses: addressesWithCharges,
      query,
      totalMatches: userMatches.length,
      trieStats: {
        totalIndexedAddresses: addressTrie.root.addresses?.length || 0
      }
    }, "Address autocomplete results")
  );
});

// Optimize delivery route using Graph
export const optimizeDeliveryRoute = asyncHandler(async (req, res) => {
  const { addressIds, startAddressId } = req.body;

  if (!addressIds || !Array.isArray(addressIds) || addressIds.length < 2) {
    throw new ApiError(400, "At least 2 address IDs required for route optimization");
  }

  // Build delivery graph with provided addresses
  const addresses = await Address.find({ _id: { $in: addressIds } }).lean();

  // Add nodes to graph
  addresses.forEach(addr => {
    deliveryGraph.addNode(
      addr._id.toString(),
      addr.location.coordinates[0],
      addr.location.coordinates[1]
    );
  });

  // Add edges between all addresses
  for (let i = 0; i < addresses.length; i++) {
    for (let j = i + 1; j < addresses.length; j++) {
      deliveryGraph.addEdge(
        addresses[i]._id.toString(),
        addresses[j]._id.toString()
      );
    }
  }

  // Calculate optimal route (simplified: nearest neighbor)
  const route = [startAddressId || addressIds[0]];
  const remaining = new Set(addressIds.filter(id => id !== route[0]));

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

  // Calculate total route distance
  let totalDistance = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const path = deliveryGraph.findShortestPath(route[i], route[i + 1]);
    if (path.found) {
      totalDistance += path.distance;
    }
  }

  res.status(200).json(
    new ApiResponse(200, {
      optimizedRoute: route,
      totalDistance,
      addressCount: route.length,
      algorithm: "Nearest Neighbor (Greedy)",
      graphStats: {
        nodes: deliveryGraph.nodes.size,
        edges: Array.from(deliveryGraph.nodes.values())
          .reduce((sum, node) => sum + node.connections.size, 0) / 2 // Divide by 2 for undirected
      }
    }, "Delivery route optimized successfully")
  );
});

// Get address analytics using DSA
export const getAddressAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const addresses = await Address.find({ user: userId }).lean();

  // Calculate analytics using DSA
  const analytics = {
    totalAddresses: addresses.length,
    addressTypes: {},
    distanceStats: {
      min: Infinity,
      max: 0,
      avg: 0,
      total: 0
    },
    deliveryChargeStats: {
      min: Infinity,
      max: 0,
      avg: 0,
      total: 0
    },
    cities: new Set(),
    states: new Set()
  };

  addresses.forEach(address => {
    // Address types count
    analytics.addressTypes[address.type] = (analytics.addressTypes[address.type] || 0) + 1;

    // Distance stats
    if (address.distance < analytics.distanceStats.min) analytics.distanceStats.min = address.distance;
    if (address.distance > analytics.distanceStats.max) analytics.distanceStats.max = address.distance;
    analytics.distanceStats.total += address.distance;

    // Delivery charge stats
    const charges = deliveryChargesCache.get(`charges_${address._id}`)?.totalCharge || address.deliveryCharges || 0;
    if (charges < analytics.deliveryChargeStats.min) analytics.deliveryChargeStats.min = charges;
    if (charges > analytics.deliveryChargeStats.max) analytics.deliveryChargeStats.max = charges;
    analytics.deliveryChargeStats.total += charges;

    // Location diversity
    analytics.cities.add(address.city);
    analytics.states.add(address.state);
  });

  // Calculate averages
  if (addresses.length > 0) {
    analytics.distanceStats.avg = analytics.distanceStats.total / addresses.length;
    analytics.deliveryChargeStats.avg = analytics.deliveryChargeStats.total / addresses.length;
  } else {
    analytics.distanceStats.min = 0;
    analytics.deliveryChargeStats.min = 0;
  }

  // Convert sets to arrays for JSON response
  analytics.cities = Array.from(analytics.cities);
  analytics.states = Array.from(analytics.states);

  res.status(200).json(
    new ApiResponse(200, {
      analytics,
      dsaPerformance: {
        cacheHitRate: deliveryChargesCache.size() / Math.max(addresses.length, 1),
        bloomFilterSize: addressBloomFilter.size,
        spatialGridCells: spatialGrid.grid.size,
        trieNodes: addressTrie.root.children ? Object.keys(addressTrie.root.children).length : 0
      }
    }, "Address analytics retrieved successfully")
  );
});