import express, { json, urlencoded } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

const app = express();
app.use(json({ limit: "16kb" }));
app.use(cookieParser());
app.use(cors({ 
    origin: "*",
    credentials: true
}));
app.use(urlencoded({ limit: "20kb", extended: true }));
app.use(express.static("public"));

// Fix the import path to include 'src'
import vegetableRoutes from "./src/routes/vegetable.js";
import offerRoutes from "./src/routes/offer.js";
import orderRoutes from "./src/routes/order.js";
import authRoutes from './src/routes/auth.js'; 
import cityRoutes from "./src/routes/City.js";

app.use("/api/cities", cityRoutes);
app.use('/api/auth', authRoutes);
app.use("/api/vegetables", vegetableRoutes);
app.use("/api/offers", offerRoutes);
app.use("/api/orders", orderRoutes);

export { app };