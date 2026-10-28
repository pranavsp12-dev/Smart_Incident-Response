import { Router } from 'express';
import {
  createIncidentAssignment,
  getIncidentAssignment,
  listIncidentAssignments,
  unassignIncidentAssignment,
  updateIncidentAssignment
} from '../controllers/incidentAssignments.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listIncidentAssignments);
router.get('/:assignmentId', getIncidentAssignment);
router.post('/', createIncidentAssignment);
router.patch('/:assignmentId', updateIncidentAssignment);
router.patch('/:assignmentId/unassign', unassignIncidentAssignment);

export default router;
