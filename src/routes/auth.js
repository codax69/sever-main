import { Router } from 'express';
import { register, login,getCurrentUser } from '../controller/auth.js';
import adminMiddleware from '../middleware/admin.js';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/get-user', adminMiddleware,getCurrentUser);


export default router;