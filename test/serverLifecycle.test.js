import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerLifecycle } from '../src/serverLifecycle.js';

test('shutdown waits for pending startup before closing database connections', async () => {
  const operations = [];
  let releaseStartup;
  let startupStarted;
  const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
  const startupEntered = new Promise((resolve) => { startupStarted = resolve; });
  const lifecycle = createServerLifecycle({
    worker: {
      async stop() { operations.push('worker-stopped'); }
    },
    async closeServer() { operations.push('server-closed'); },
    async closeMongo() { operations.push('mongo-closed'); },
    async closePostgres() { operations.push('postgres-closed'); }
  });

  const starting = lifecycle.start(async (isStopping) => {
    startupStarted();
    await startupGate;
    if (!isStopping()) operations.push('worker-started');
    operations.push('startup-finished');
  });
  await startupEntered;
  const stopping = lifecycle.shutdown();
  await Promise.resolve();

  assert.deepEqual(operations, ['worker-stopped']);
  releaseStartup();
  await Promise.all([starting, stopping]);

  assert.deepEqual(operations, [
    'worker-stopped',
    'startup-finished',
    'worker-stopped',
    'server-closed',
    'mongo-closed',
    'postgres-closed'
  ]);
});

test('shutdown that begins before startup prevents startup from running', async () => {
  let startupCalled = false;
  const lifecycle = createServerLifecycle({
    worker: { async stop() {} },
    async closeServer() {},
    async closeMongo() {},
    async closePostgres() {}
  });

  await lifecycle.shutdown();
  assert.equal(await lifecycle.start(async () => { startupCalled = true; }), false);
  assert.equal(startupCalled, false);
});
