// In your routes file
import express from 'express';
import { exportCustomers } from '../controller/export.controller.js';

const router = express.Router();

router.post('/export-customers', exportCustomers);

export default router;