import { Router } from 'express';
import {
  createEscalationLevel,
  createEscalationPolicy,
  deleteEscalationLevel,
  deleteEscalationPolicy,
  getEscalationLevel,
  getEscalationPolicy,
  listEscalationLevels,
  listEscalationPolicies,
  updateEscalationLevel,
  updateEscalationPolicy
} from '../controllers/escalationPolicies.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listEscalationPolicies);
router.get('/:policyId/levels/:levelId', getEscalationLevel);
router.get('/:policyId/levels', listEscalationLevels);
router.post('/:policyId/levels', createEscalationLevel);
router.patch('/:policyId/levels/:levelId', updateEscalationLevel);
router.delete('/:policyId/levels/:levelId', deleteEscalationLevel);
router.get('/:policyId', getEscalationPolicy);
router.post('/', createEscalationPolicy);
router.patch('/:policyId', updateEscalationPolicy);
router.delete('/:policyId', deleteEscalationPolicy);

export default router;
