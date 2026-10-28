import app from './app.js';
import { env } from './config/env.js';
import { pgPool, testPostgresConnection } from './config/postgres.js';
import { closeMongo, testMongoConnection } from './config/mongodb.js';
import { createEscalationWorker } from './services/escalations.worker.js';
import { createServerLifecycle } from './serverLifecycle.js';

const PORT = env.PORT;
const escalationWorker = createEscalationWorker();
let server;
const lifecycle = createServerLifecycle({
  worker: escalationWorker,
  closeServer: () => new Promise((resolve) => server.close(resolve)),
  closeMongo,
  closePostgres: () => pgPool.end()
});

server = app.listen(PORT, () => {
  console.log('====================================================');
  console.log(' Smart Incident Response & Service On-Call Backend');
  console.log(` Server listening on: http://localhost:${PORT}`);
  console.log(` Health check URL:   http://localhost:${PORT}/api/health`);
  console.log(` Environment:        ${env.NODE_ENV}`);
  console.log('====================================================');

  void lifecycle.start(async (isStopping) => {
    console.log('[Database Connectivity Verification]');

    const pgCheck = await testPostgresConnection();
    if (pgCheck.connected) {
      console.log(` ✓ PostgreSQL: Connected (${pgCheck.message})`);
    } else {
      console.log(` ✗ PostgreSQL: Not connected (${pgCheck.error || pgCheck.message})`);
    }

    const mongoCheck = await testMongoConnection();
    if (mongoCheck.connected) {
      console.log(` ✓ MongoDB: Connected (database: ${mongoCheck.databaseName})`);
    } else {
      console.log(` ✗ MongoDB: Not connected (${mongoCheck.error || mongoCheck.message})`);
    }

    if (isStopping()) {
      console.log('[Escalation worker] Not started because shutdown has begun.');
    } else if (env.NODE_ENV === 'test') {
      console.log('[Escalation worker] Disabled in test environment.');
    } else if (pgCheck.connected && mongoCheck.connected) {
      try {
        await escalationWorker.start();
        console.log('[Escalation worker] Started.');
      } catch (error) {
        console.error('[Escalation worker] Not started:', error.message);
      }
    } else {
      console.error('[Escalation worker] Not started because a required database is unavailable.');
    }

    console.log('====================================================\n');
  });
});

let shutdownPromise;
async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  console.log(`\nReceived ${signal}; stopping escalation worker and server...`);
  shutdownPromise = lifecycle.shutdown().then(() => {
    console.log('HTTP server and database connections closed.');
  });
  try {
    await shutdownPromise;
  } catch (error) {
    console.error('Graceful shutdown failed:', error.code || error.name);
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
