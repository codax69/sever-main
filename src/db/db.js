import mongoose from "mongoose";
import dns from "node:dns";

// Force Node.js to use Google DNS and prefer IPv4
// Fixes SRV lookup failures on restricted networks
dns.setServers(["8.8.8.8", "8.8.4.4"]);
dns.setDefaultResultOrder("ipv4first");

export const ConnectDB = async () => {
  try {
    const connectionDB = await mongoose.connect(
      `${process.env.DB_URI}/${"VegBazarDEV"}`,
      { family: 4 },
    );
    console.log("DB HOSTED ON:", connectionDB.connection.host);

    // Remove stale MongoDB $jsonSchema validators from collections
    // that conflict with current Mongoose schema definitions
    try {
      const db = connectionDB.connection.db;
      await db.command({
        collMod: "orders",
        validator: {},
        validationLevel: "off",
      });
      console.log("✅ Removed stale validator from 'orders' collection");
    } catch (validatorErr) {
      // Collection may not exist yet or no validator to remove — safe to ignore
      if (validatorErr.codeName !== "NamespaceNotFound") {
        console.warn(
          "⚠️ Could not remove orders validator:",
          validatorErr.message,
        );
      }
    }
  } catch (error) {
    if (error.name === "MongooseServerSelectionError") {
      console.error(
        "\n❌ MongoDB Connection Error: Could not connect to any servers.",
      );
      console.error(
        "👉 This is usually caused by your IP address not being whitelisted in MongoDB Atlas.",
      );
      console.error("🔗 Whitelist your IP here: https://cloud.mongodb.com/\n");
    } else {
      console.log("DataBase Connection ERROR:", error);
    }
    process.exit(1);
  }
};
