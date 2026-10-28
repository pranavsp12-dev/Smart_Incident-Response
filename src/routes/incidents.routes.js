import { Router } from 'express';
import {
  createIncident,
  getIncident,
  listIncidents,
  updateIncident
} from '../controllers/incidents.controller.js';
import {
  createIncidentUpdate,
  getIncidentUpdate,
  listIncidentUpdates
} from '../controllers/incidentUpdates.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listIncidents);
router.get('/:incidentId/updates', listIncidentUpdates);
router.get('/:incidentId/updates/:updateId', getIncidentUpdate);
router.post('/:incidentId/updates', createIncidentUpdate);
router.get('/:incidentId', getIncident);
router.post('/', createIncident);
router.patch('/:incidentId', updateIncident);

export default router;
