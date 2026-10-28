import { Router } from 'express';
import {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  updateTeam
} from '../controllers/teams.controller.js';
import { authenticate, requireRole } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listTeams);
router.get('/:teamId', getTeam);
router.post('/', requireRole('admin'), createTeam);
router.patch('/:teamId', requireRole('admin', 'manager'), updateTeam);
router.delete('/:teamId', requireRole('admin'), deleteTeam);

export default router;
