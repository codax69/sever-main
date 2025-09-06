import mongoose from "mongoose";
import { DB_NAME } from "../../const.js";
export const ConnectDB = async () => {
    try {
      const connectionDB = await mongoose.connect(
        `${process.env.DB_URI}/${DB_NAME}`,
      );
      console.log("DB HOSTED ON:", connectionDB.connection.host);
    } catch (error) {
      console.log("DataBase Connection ERROR:", error);
      process.exit(1);
    }
  };