import mongoose from "mongoose";
export const ConnectDB = async () => {
  try {
    const connectionDB = await mongoose.connect(
      `${process.env.DB_URI}/${process.env.DB_NAME}`,
    );
    console.log("DB HOSTED ON:", connectionDB.connection.host);
  } catch (error) {
      console.log("DataBase Connection ERROR:", error);
      process.exit(1);
  }
};