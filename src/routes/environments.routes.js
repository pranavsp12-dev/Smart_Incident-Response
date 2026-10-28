import { Router } from 'express';
import {
  createEnvironment,
  getEnvironment,
  listEnvironments,
  updateEnvironment
} from '../controllers/environments.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listEnvironments);
router.get('/:environmentId', getEnvironment);
router.post('/', createEnvironment);
router.patch('/:environmentId', updateEnvironment);

export default router;
