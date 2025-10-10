import { Router } from "express";
import {verifyCaptcha} from "../controller/captcha.js";

const router = Router();

router.post("/verify-captcha",verifyCaptcha)

export default router;