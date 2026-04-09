import rateLimit from "express-rate-limit";

// General API Rate Limiter
export const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 1 minute.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Major Route Rate Limiter (vegetables, cart, orders, etc.)
export const majorLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30, // stricter than general (60), looser than sensitive (5)
  message: {
    success: false,
    message: "Too many requests to this api, please try again after 1 minute.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Sensitive Route Rate Limiter (OTP/Auth)
export const sensitiveLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Too many requests to this endpoint, please try again after 1 minute.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});