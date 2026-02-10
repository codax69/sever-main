import mongoose from "mongoose";
export const ConnectDB = async () => {
  try {
    const connectionDB = await mongoose.connect(
      `${process.env.DB_URI}/${process.env.DB_NAME}`,
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
    console.log("DataBase Connection ERROR:", error);
    process.exit(1);
  }
};
