import { expressjwt } from "express-jwt";
import jwksRsa from "jwks-rsa";
import User from "../Model/user.js";
import "dotenv/config";

/* -------------------------------------------------
   1. Verify Auth0 JWT (cryptographically correct)
-------------------------------------------------- */
export const checkAuth0Jwt = expressjwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  }),
  audience: process.env.AUTH0_AUDIENCE,
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  algorithms: ["RS256"],
});

/* -------------------------------------------------
   2. Attach internal user from DB (business logic)
-------------------------------------------------- */
export const attachUser = async (req, res, next) => {
  try {
    const auth0Id = req.auth?.sub; // e.g. auth0|65fa...

    if (!auth0Id) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    const user = await User.findOne({ auth0Id }).select(
      "-password -refreshToken"
    );

    if (!user) {
      return res.status(403).json({
        success: false,
        message: "User not registered in system",
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account deactivated",
      });
    }

    if (
      ["delivery_partner", "packaging", "editor"].includes(user.role) &&
      !user.isApproved
    ) {
      return res.status(403).json({
        success: false,
        message: "Account pending approval",
        needsApproval: true,
      });
    }

    req.user = {
      id: user._id,
      auth0Id,
      email: user.email,
      role: user.role,
      username: user.username,
      isApproved: user.isApproved,
      isActive: user.isActive,
    };

    next();
  } catch (err) {
    console.error("Auth attach error:", err);
    res.status(500).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

/* -------------------------------------------------
   3. Role authorization (this survives)
-------------------------------------------------- */
export const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    next();
  };
};

/* -------------------------------------------------
   4. Optional Auth (non-blocking)
-------------------------------------------------- */
export const optionalAuth = (req, res, next) => {
  checkAuth0Jwt(req, res, (err) => {
    if (err) return next(); // ignore auth errors
    attachUser(req, res, next);
  });
};

/* -------------------------------------------------
   Default export (admin protection)
-------------------------------------------------- */
const adminMiddleware = [
  checkAuth0Jwt,
  attachUser,
  authorizeRoles("admin"),
];

export default adminMiddleware;
