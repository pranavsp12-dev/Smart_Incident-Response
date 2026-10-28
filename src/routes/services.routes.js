import { Router } from 'express';
import {
  createService,
  deactivateService,
  getService,
  listServices,
  updateService
} from '../controllers/services.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listServices);
router.get('/:serviceId', getService);
router.post('/', createService);
router.patch('/:serviceId', updateService);
router.patch('/:serviceId/deactivate', deactivateService);

export default router;
