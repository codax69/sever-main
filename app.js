import "dotenv/config";
import express, { json, urlencoded } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const allowedOrigins = [
  "https://admin.vegbazar.cloud",
  "https://vegbazar.store",
  "http://localhost:5173",
];

const app = express();

/* ================= CORE MIDDLEWARE ================= */
app.use(json({ limit: "50mb" }));
app.use(urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());
app.use(express.static("public"));

/* ================= CORS ================= */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

/* ================= ROUTES ================= */
// Public / utility routes
import otpRoutes from "./src/routes/otp.js";

app.use("/api/otp", otpRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Application routes
import vegetableRoutes from "./src/routes/vegetable.js";
import orderRoutes from "./src/routes/order.js";
import authRoutes from "./src/routes/auth.js";
import cityRoutes from "./src/routes/City.js";
import invoiceRoutes from "./src/routes/invoice.js";
import testimonialRoutes from "./src/routes/testimonial.js";
import couponRoutes from "./src/routes/coupon.js";
import userRoutes from "./src/routes/user.js";
import addressRoutes from "./src/routes/address.js";
import cartRoutes from "./src/routes/cart.js";
import orderReportsRoutes from "./src/routes/OrderReport.route.js";
import exportRoutes from "./src/routes/export.route.js";
import reportRoutes from "./src/routes/report.routes.js";
import basketRoutes from "./src/routes/basket.js";
import walletRoutes from "./src/routes/wallet.routes.js";

app.use("/api/report", reportRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/cities", cityRoutes);
app.use("/api/vegetables", vegetableRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/testimonials", testimonialRoutes);
app.use("/api/invoice", invoiceRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/user", userRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/reports", orderReportsRoutes);
app.use("/api/baskets", basketRoutes);
app.use("/api/wallet", walletRoutes);

/* ================= GLOBAL ERROR HANDLER ================= */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    success: false,
    error: err.name || "InternalServerError",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

export { app };
