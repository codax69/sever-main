import { ConnectDB } from "./src/db/db.js";
import dotenv from 'dotenv'
import {app} from './app.js'
dotenv.config({
    path:"./.env"
})
const port = process.env.PORT || 3000


ConnectDB().then(()=>{
    app.listen(port,()=>{
        console.log(`Your server running on ${port} port`)
    })
}).catch((error)=>{
    console.log(`MongoDB Connection Failed`,error)
})