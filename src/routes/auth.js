import { Router } from 'express';
import { register, login,getCurrentUser,verifyCaptcha } from '../controller/auth.js';
import adminMiddleware from '../middleware/admin.js';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/get-user', adminMiddleware,getCurrentUser);
router.post("/verify-captcha",verifyCaptcha)

export default router;