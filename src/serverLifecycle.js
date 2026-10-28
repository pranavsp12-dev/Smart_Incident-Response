export function createServerLifecycle({
  worker,
  closeServer,
  closeMongo,
  closePostgres,
  logger = console
}) {
  let stopping = false;
  let startupPromise = null;
  let shutdownPromise = null;

  function start(startup) {
    if (stopping) return Promise.resolve(false);
    if (startupPromise) return startupPromise;

    startupPromise = (async () => {
      try {
        await startup(() => stopping);
        return true;
      } catch (error) {
        logger.error('[Server] Startup checks failed:', error.code || error.name);
        return false;
      }
    })();
    return startupPromise;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const workerStop = Promise.resolve().then(() => worker.stop());

    shutdownPromise = (async () => {
      await workerStop;
      if (startupPromise) await startupPromise;
      await worker.stop();
      await closeServer();
      await closeMongo();
      await closePostgres();
    })();
    return shutdownPromise;
  }

  return { start, shutdown, isStopping: () => stopping };
}
