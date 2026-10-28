import { getHealthStatus } from '../services/health.service.js';

/**
 * Controller for GET /api/health
 */
export async function checkHealth(req, res, next) {
  try {
    const health = await getHealthStatus();
    res.status(200).json(health);
  } catch (error) {
    next(error);
  }
}
