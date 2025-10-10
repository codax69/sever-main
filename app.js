import express, { json, urlencoded } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();
app.use(json({ limit: "16kb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);
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
app.use("/api/cities", cityRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/vegetables", vegetableRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/invoice", invoiceRoutes);
app.use("/api/otp", otpRoutes);
app.use("/api", captchaRoutes);
export { app };
