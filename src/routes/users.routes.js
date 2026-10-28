import { Router } from 'express';
import {
  createUser,
  deactivateUser,
  getUser,
  listUsers,
  updateUser
} from '../controllers/users.controller.js';
import { authenticate, requireRole } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listUsers);
router.get('/:userId', getUser);
router.post('/', requireRole('admin', 'manager'), createUser);
router.patch('/:userId', updateUser);
router.patch('/:userId/deactivate', requireRole('admin', 'manager'), deactivateUser);

export default router;
