import { Router } from 'express';
import {
  createSchedule,
  createScheduleAssignment,
  deleteSchedule,
  deleteScheduleAssignment,
  getSchedule,
  getScheduleAssignment,
  listScheduleAssignments,
  listSchedules,
  updateSchedule,
  updateScheduleAssignment
} from '../controllers/onCallSchedules.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

router.use(authenticate);
router.get('/', listSchedules);
router.get('/:scheduleId/assignments/:assignmentId', getScheduleAssignment);
router.get('/:scheduleId/assignments', listScheduleAssignments);
router.post('/:scheduleId/assignments', createScheduleAssignment);
router.patch('/:scheduleId/assignments/:assignmentId', updateScheduleAssignment);
router.delete('/:scheduleId/assignments/:assignmentId', deleteScheduleAssignment);
router.get('/:scheduleId', getSchedule);
router.post('/', createSchedule);
router.patch('/:scheduleId', updateSchedule);
router.delete('/:scheduleId', deleteSchedule);

export default router;
