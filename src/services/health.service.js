import { testPostgresConnection } from '../config/postgres.js';
import { testMongoConnection } from '../config/mongodb.js';

/**
 * Service to aggregate server and database health status
 */
export async function getHealthStatus() {
  const postgres = await testPostgresConnection();
  const mongodb = await testMongoConnection();

  return {
    status: 'OK',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    databases: {
      postgres,
      mongodb
    }
  };
}
