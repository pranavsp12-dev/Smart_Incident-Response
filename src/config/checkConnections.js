import { testPostgresConnection, pgPool } from './postgres.js';
import { testMongoConnection, closeMongo } from './mongodb.js';

async function runCheck() {
  console.log('--- Testing Database Connections ---');

  console.log('\n[1/2] Testing PostgreSQL...');
  const pgResult = await testPostgresConnection();
  if (pgResult.connected) {
    console.log('✓ PostgreSQL:', pgResult.message);
    if (pgResult.serverTime) console.log('  Server Time:', pgResult.serverTime);
  } else {
    console.log('✗ PostgreSQL:', pgResult.message);
    console.log('  Detail:', pgResult.error);
  }

  console.log('\n[2/2] Testing MongoDB...');
  const mongoResult = await testMongoConnection();
  if (mongoResult.connected) {
    console.log('✓ MongoDB:', mongoResult.message);
    if (mongoResult.databaseName) console.log('  Database:', mongoResult.databaseName);
  } else {
    console.log('✗ MongoDB:', mongoResult.message);
    console.log('  Detail:', mongoResult.error);
  }

  // Gracefully clean up
  try {
    await pgPool.end();
  } catch (_) {}

  try {
    await closeMongo();
  } catch (_) {}

  console.log('\n--- Database Connection Check Complete ---');
  process.exit(pgResult.connected && mongoResult.connected ? 0 : 1);
}

runCheck().catch((err) => {
  console.error('Fatal error during connection check:', err);
  process.exit(1);
});
