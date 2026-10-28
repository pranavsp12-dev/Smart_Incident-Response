import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

/**
 * PostgreSQL Connection Pool
 * Configured using environment variables from .env
 */
export const pgPool = new Pool({
  host: env.PG.HOST,
  port: env.PG.PORT,
  database: env.PG.DATABASE,
  user: env.PG.USER,
  password: env.PG.PASSWORD,
  connectionTimeoutMillis: 3000 // 3 seconds timeout
});

/**
 * Test PostgreSQL connectivity with a real query.
 * Only returns connected: true when the query actually succeeds.
 */
export async function testPostgresConnection() {
  let client;
  try {
    client = await pgPool.connect();
    const result = await client.query('SELECT NOW() as current_time');
    return {
      connected: true,
      message: 'PostgreSQL connection successful',
      serverTime: result.rows[0].current_time
    };
  } catch (error) {
    let errorDetail = error.message;
    if (!errorDetail && error.code) {
      errorDetail = `${error.code}: Connection refused at ${env.PG.HOST}:${env.PG.PORT}`;
    } else if (!errorDetail && Array.isArray(error.errors) && error.errors.length > 0) {
      errorDetail = error.errors.map(e => e.message || e.code).join(', ');
    }
    return {
      connected: false,
      message: 'PostgreSQL connection failed',
      error: errorDetail || 'Unable to connect to PostgreSQL server'
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}
