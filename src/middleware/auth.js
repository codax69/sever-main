import jwt from "jsonwebtoken";

const userMiddleware = (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "").trim();

    if (!token) {
      return res
        .status(401)
        .json({ message: "Authentication required" });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user data to request
    req.user = decoded;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ message: "Session expired. Please login again." });
    }

    if (error.name === "JsonWebTokenError") {
      return res
        .status(401)
        .json({ message: "Invalid authentication token" });
    }

    return res
      .status(401)
      .json({ message: "Authentication failed" });
  }
};

export default userMiddleware;
