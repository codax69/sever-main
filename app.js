import express, { json, urlencoded } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const allowedOrigins = [
  "https://admin.vegbazar.cloud",
  "https://vegbazar.store",
  "http://localhost:5173",
];
const app = express();
app.use(json({ limit: "16kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,DELETE,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(urlencoded({ limit: "20kb", extended: true }));
app.use(express.static("public"));

import vegetableRoutes from "./src/routes/vegetable.js";
import offerRoutes from "./src/routes/offer.js";
import orderRoutes from "./src/routes/order.js";
import authRoutes from "./src/routes/auth.js";
import cityRoutes from "./src/routes/City.js";
import otpRoutes from "./src/routes/otp.js";
import invoiceRoutes from "./src/routes/invoice.js";
import captchaRoutes from "./src/routes/captcha.js";
import testimonialRoutes from "./src/routes/testimonial.js";
import couponRoutes from "./src/routes/coupon.js";
import userRoutes from "./src/routes/user.js";
import addressRoutes from "./src/routes/address.js";
import cartRoutes from "./src/routes/cart.js";
import orderReportsRoutes from "./src/routes/OrderReport.route.js";
app.use("/api/cities", cityRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/vegetables", vegetableRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/testimonials", testimonialRoutes);
app.use("/api/invoice", invoiceRoutes);
app.use("/api/otp", otpRoutes);
app.use("/api", captchaRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/user", userRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/reports", orderReportsRoutes);
export { app };
