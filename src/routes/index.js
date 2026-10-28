import { Router } from 'express';
import healthRoutes from './health.routes.js';
import authRoutes from './auth.routes.js';
import teamRoutes from './teams.routes.js';
import userRoutes from './users.routes.js';
import serviceRoutes from './services.routes.js';
import environmentRoutes from './environments.routes.js';
import incidentRoutes from './incidents.routes.js';
import incidentAssignmentRoutes from './incidentAssignments.routes.js';
import escalationPolicyRoutes from './escalationPolicies.routes.js';
import onCallScheduleRoutes from './onCallSchedules.routes.js';

const router = Router();

// Base API route
router.get('/', (req, res) => {
  res.json({
    message: 'Smart Incident Response & Service On-Call API is running',
    version: '1.0.0',
    endpoints: {
      health: '/api/health'
    }
  });
});

// Health check endpoint -> /api/health
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/teams', teamRoutes);
router.use('/users', userRoutes);
router.use('/services', serviceRoutes);
router.use('/environments', environmentRoutes);
router.use('/incidents', incidentRoutes);
router.use('/incident-assignments', incidentAssignmentRoutes);
router.use('/escalation-policies', escalationPolicyRoutes);
router.use('/on-call-schedules', onCallScheduleRoutes);

export default router;
