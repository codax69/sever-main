import jwt from "jsonwebtoken";

const adminMiddleware = (req, res, next) => {
  try {
    // Get token from header
    const token =
      req.cookies?.token ||
      req.header("Authorization")?.replace("Bearer ", "").trim();

      console.log(token)

    if (!token) {
      return res
        .status(401)
        .json({ message: "No token, authorization denied" });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Check if user has admin role
    if (decoded.role !== "admin") {
      return res
        .status(403)
        .json({ message: "Access denied. Admin rights required" });
    }

    // Add user from payload
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

export default adminMiddleware;
