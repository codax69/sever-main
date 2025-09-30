import jwt from "jsonwebtoken";

const adminMiddleware = (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({ message: "No token, authorization denied" });
    }
    

    // Verify access token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    // Role check (only admin allowed)
    if (decoded.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Access denied. Admin rights required" });
    }

    // Attach user to request
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired, please login again" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }
    res.status(401).json({ message: "Authentication failed" });
  }
};

export default adminMiddleware;
