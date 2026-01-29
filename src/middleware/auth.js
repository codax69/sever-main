import jwt from "jsonwebtoken";
import { ApiError } from "../utility/ApiError.js";
import { asyncHandler } from "../utility/AsyncHandler.js";
import User from "../Model/user.js";

// ================= CONFIGURATION =================
const CONFIG = Object.freeze({
  jwt: {
    secret: process.env.JWT_SECRET,
    accessType: "access",
  },
  rateLimit: {
    maxAttempts: 10,
    windowMs: 60 * 1000, // 60 seconds
    cleanupIntervalMs: 60 * 1000 , // 1 hour
  },
  cache: {
    userTTL: 5 * 60 * 1000, // 5 minutes
    maxSize: 1000,
  },
});

// ================= LRU CACHE FOR USER DATA =================
class LRUCache {
  #cache = new Map();
  #maxSize;

  constructor(maxSize = CONFIG.cache.maxSize) {
    this.#maxSize = maxSize;
  }

  get(key) {
    if (!this.#cache.has(key)) return null;
    const value = this.#cache.get(key);
    
    // Check if expired
    if (value.expiresAt && Date.now() > value.expiresAt) {
      this.#cache.delete(key);
      return null;
    }
    
    // Move to end (most recently used)
    this.#cache.delete(key);
    this.#cache.set(key, value);
    return value.data;
  }

  set(key, data, ttl = CONFIG.cache.userTTL) {
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    } else if (this.#cache.size >= this.#maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.#cache.keys().next().value;
      this.#cache.delete(firstKey);
    }
    
    this.#cache.set(key, {
      data,
      expiresAt: ttl ? Date.now() + ttl : null,
    });
  }

  invalidate(key) {
    this.#cache.delete(key);
  }

  clear() {
    this.#cache.clear();
  }

  size() {
    return this.#cache.size;
  }
}

// Global cache instance
const userCache = new LRUCache();

// ================= TOKEN EXTRACTION UTILITY =================
const extractToken = (req) => {
  // Priority: Cookie > Authorization header
  return req.cookies?.accessToken || req.header("Authorization")?.replace(/^Bearer\s+/i, "");
};

// ================= TOKEN VERIFICATION UTILITY =================
const verifyToken = (token) => {
  try {
    const decoded = jwt.verify(token, CONFIG.jwt.secret);
    
    if (decoded.type !== CONFIG.jwt.accessType) {
      throw new ApiError(401, "Invalid token type");
    }
    
    return decoded;
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      throw new ApiError(401, "Invalid access token");
    }
    if (error.name === "TokenExpiredError") {
      throw new ApiError(401, "Access token expired. Please refresh.");
    }
    throw error;
  }
};

// ================= USER FETCHING WITH CACHE =================
const fetchUser = async (userId) => {
  // Check cache first
  const cached = userCache.get(userId);
  if (cached) return cached;

  // Fetch from database
  const user = await User.findById(userId)
    .select("-password -refreshToken")
    .lean();

  if (!user) {
    throw new ApiError(401, "Invalid token - user not found");
  }

  if (!user.isActive) {
    throw new ApiError(403, "Account is deactivated");
  }

  // Normalize user data
  const userData = {
    id: user._id.toString(),
    email: user.email,
    username: user.username,
    role: user.role,
    phone: user.phone,
    picture: user.picture,
    defaultAddress: user.defaultAddress,
    addresses: user.addresses,
    isEmailVerified: user.isEmailVerified,
    isActive: user.isActive,
  };

  // Cache the user
  userCache.set(userId, userData);

  return userData;
};

// ================= VERIFY JWT MIDDLEWARE =================
export const verifyJWT = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    throw new ApiError(401, "Access token required. Please login.");
  }

  const decoded = verifyToken(token);
  req.user = await fetchUser(decoded.id);

  next();
});

// ================= CHECK IF USER IS ADMIN =================
export const isAdmin = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    throw new ApiError(401, "Authentication required");
  }

  if (req.user.role !== "admin") {
    throw new ApiError(403, "Admin access required");
  }

  next();
});

// ================= CHECK IF USER IS OWNER OR ADMIN =================
export const isOwnerOrAdmin = asyncHandler(async (req, res, next) => {
  if (!req.user) {
    throw new ApiError(401, "Authentication required");
  }

  const userId = req.params.userId || req.params.id;

  // Allow if admin or if user is accessing their own resource
  if (req.user.role === "admin" || req.user.id === userId) {
    return next();
  }

  throw new ApiError(403, "Access denied");
});

// ================= OPTIONAL AUTH MIDDLEWARE =================
export const optionalAuth = asyncHandler(async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (token) {
      const decoded = verifyToken(token);
      req.user = await fetchUser(decoded.id);
    }
  } catch (error) {
    // Silently fail - auth is optional
    req.user = null;
  }

  next();
});

// ================= SLIDING WINDOW RATE LIMITER =================
class SlidingWindowRateLimiter {
  #attempts = new Map();
  #maxAttempts;
  #windowMs;

  constructor(maxAttempts = CONFIG.rateLimit.maxAttempts, windowMs = CONFIG.rateLimit.windowMs) {
    this.#maxAttempts = maxAttempts;
    this.#windowMs = windowMs;
    
    // Start cleanup interval
    this.#startCleanup();
  }

  isRateLimited(identifier) {
    const now = Date.now();
    const windowStart = now - this.#windowMs;

    // Get or create attempt log
    let attempts = this.#attempts.get(identifier);
    
    if (!attempts) {
      attempts = [];
      this.#attempts.set(identifier, attempts);
    }

    // Remove expired attempts (sliding window)
    const validAttempts = attempts.filter(timestamp => timestamp > windowStart);
    this.#attempts.set(identifier, validAttempts);

    // Check if rate limited
    if (validAttempts.length >= this.#maxAttempts) {
      const oldestAttempt = Math.min(...validAttempts);
      const resetTime = oldestAttempt + this.#windowMs;
      const waitMinutes = Math.ceil((resetTime - now) / 60000);
      
      return {
        limited: true,
        waitMinutes,
        resetTime,
      };
    }

    // Record new attempt
    validAttempts.push(now);
    this.#attempts.set(identifier, validAttempts);

    return { limited: false };
  }

  reset(identifier) {
    this.#attempts.delete(identifier);
  }

  #startCleanup() {
    setInterval(() => {
      const now = Date.now();
      const windowStart = now - this.#windowMs;

      for (const [identifier, attempts] of this.#attempts.entries()) {
        // Remove expired attempts
        const validAttempts = attempts.filter(timestamp => timestamp > windowStart);
        
        if (validAttempts.length === 0) {
          this.#attempts.delete(identifier);
        } else {
          this.#attempts.set(identifier, validAttempts);
        }
      }
    }, CONFIG.rateLimit.cleanupIntervalMs);
  }

  getStats() {
    return {
      totalIdentifiers: this.#attempts.size,
      maxAttempts: this.#maxAttempts,
      windowMs: this.#windowMs,
    };
  }
}

// Global rate limiter instance
const loginRateLimiter = new SlidingWindowRateLimiter();

// ================= RATE LIMIT MIDDLEWARE =================
export const rateLimitLogin = (req, res, next) => {
  const identifier = req.body.email || req.body.phone || req.ip;

  if (!identifier) {
    return next();
  }

  // Check if IP is blocked
  if (ipBlacklist.has(req.ip)) {
    throw new ApiError(403, "Your IP address has been blocked due to multiple failed login attempts");
  }

  const result = loginRateLimiter.isRateLimited(identifier);

  if (result.limited) {
    // Block the IP after 10 failed attempts
    blockIP(req.ip);
    
    throw new ApiError(
      429,
      `Too many login attempts. Your IP has been blocked for security. Please try again in ${result.waitMinutes} minute${result.waitMinutes > 1 ? 's' : ''}.`
    );
  }

  next();
};

// ================= ADVANCED RATE LIMITER (Configurable) =================
export const createRateLimiter = (options = {}) => {
  const {
    maxAttempts = 10,
    windowMs = 60000, // 1 minute
    keyGenerator = (req) => req.ip,
    message = "Too many requests. Please try again later.",
  } = options;

  const limiter = new SlidingWindowRateLimiter(maxAttempts, windowMs);

  return (req, res, next) => {
    const key = keyGenerator(req);
    
    if (!key) {
      return next();
    }

    const result = limiter.isRateLimited(key);

    if (result.limited) {
      throw new ApiError(429, message);
    }

    next();
  };
};

// ================= ROLE-BASED ACCESS CONTROL =================
export const requireRoles = (...allowedRoles) => {
  const rolesSet = new Set(allowedRoles);
  
  return asyncHandler(async (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, "Authentication required");
    }

    if (!rolesSet.has(req.user.role)) {
      throw new ApiError(403, `Access denied. Required roles: ${allowedRoles.join(", ")}`);
    }

    next();
  });
};

// ================= PERMISSION-BASED ACCESS CONTROL =================
export const requirePermissions = (...requiredPermissions) => {
  const permissionsSet = new Set(requiredPermissions);
  
  return asyncHandler(async (req, res, next) => {
    if (!req.user) {
      throw new ApiError(401, "Authentication required");
    }

    // Fetch full user with permissions if not cached
    const user = await User.findById(req.user.id)
      .select("permissions")
      .lean();

    if (!user || !user.permissions) {
      throw new ApiError(403, "Insufficient permissions");
    }

    const userPermissions = new Set(user.permissions);
    const hasAllPermissions = [...permissionsSet].every(perm => userPermissions.has(perm));

    if (!hasAllPermissions) {
      throw new ApiError(403, `Missing permissions: ${requiredPermissions.join(", ")}`);
    }

    next();
  });
};

// ================= CACHE INVALIDATION UTILITIES =================
export const invalidateUserCache = (userId) => {
  userCache.invalidate(userId);
};

export const clearUserCache = () => {
  userCache.clear();
};

// ================= EXPORTS FOR MONITORING =================
export const getAuthStats = () => ({
  userCache: {
    size: userCache.size(),
    maxSize: CONFIG.cache.maxSize,
    ttl: CONFIG.cache.userTTL,
  },
  rateLimit: loginRateLimiter.getStats(),
});

// ================= TOKEN BLACKLIST (Optional Enhancement) =================
class TokenBlacklist {
  #blacklist = new Set();
  #expiryMap = new Map();

  add(token, expiresAt) {
    this.#blacklist.add(token);
    this.#expiryMap.set(token, expiresAt);
  }

  has(token) {
    return this.#blacklist.has(token);
  }

  cleanup() {
    const now = Date.now();
    for (const [token, expiresAt] of this.#expiryMap.entries()) {
      if (now > expiresAt) {
        this.#blacklist.delete(token);
        this.#expiryMap.delete(token);
      }
    }
  }

  size() {
    return this.#blacklist.size;
  }
}

const tokenBlacklist = new TokenBlacklist();

// Cleanup blacklist every hour
setInterval(() => {
  tokenBlacklist.cleanup();
}, CONFIG.rateLimit.cleanupIntervalMs);

export const blacklistToken = (token, expiresAt) => {
  tokenBlacklist.add(token, expiresAt);
};

export const isTokenBlacklisted = (token) => {
  return tokenBlacklist.has(token);
};

// Enhanced verifyJWT with blacklist check
export const verifyJWTWithBlacklist = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    throw new ApiError(401, "Access token required. Please login.");
  }

  // Check if token is blacklisted (for logout functionality)
  if (isTokenBlacklisted(token)) {
    throw new ApiError(401, "Token has been revoked. Please login again.");
  }

  const decoded = verifyToken(token);
  req.user = await fetchUser(decoded.id);

  next();
});

// ================= IP WHITELIST/BLACKLIST (Optional) =================
const ipBlacklist = new Set();
const ipWhitelist = new Map(); // Store {ip: expiresAt}

const IP_WHITELIST_TTL = 5 * 60 * 1000; // 5 minutes

export const blockIP = (ip) => {
  ipBlacklist.add(ip);
};

export const allowIP = (ip, ttl = IP_WHITELIST_TTL) => {
  const expiresAt = Date.now() + ttl;
  ipWhitelist.set(ip, expiresAt);
};

export const checkIPRestrictions = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;

  // Check if whitelisted IP has expired
  if (ipWhitelist.has(clientIP)) {
    const expiresAt = ipWhitelist.get(clientIP);
    if (Date.now() > expiresAt) {
      ipWhitelist.delete(clientIP);
    } else {
      // IP is still whitelisted
      return next();
    }
  }

  // If whitelist is active, only allow whitelisted IPs
  if (ipWhitelist.size > 0 && !ipWhitelist.has(clientIP)) {
    throw new ApiError(403, "Access denied from this IP address");
  }

  // Block blacklisted IPs
  if (ipBlacklist.has(clientIP)) {
    throw new ApiError(403, "Your IP address has been blocked");
  }

  next();
};

// Cleanup expired whitelist entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, expiresAt] of ipWhitelist.entries()) {
    if (now > expiresAt) {
      ipWhitelist.delete(ip);
    }
  }
}, IP_WHITELIST_TTL);