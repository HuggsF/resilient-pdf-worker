import './module-aliases';
import { buildWorkerContainer } from '@infrastructure/config/container';
import { loadConfig, loadEnvFile } from '@infrastructure/config/env';
import { migrateLatest } from '@infrastructure/database/migrator';
import { registerGracefulShutdown } from '@infrastructure/lifecycle/graceful-shutdown';
import type { GracefulShutdown } from '@infrastructure/lifecycle/graceful-shutdown';
import { createLogger } from '@infrastructure/logging/logger';
import { closeServer, listen } from '@presentation/http/server';
import { startWorkerRuntime } from '@presentation/worker/worker-runtime';

/**
 * Worker process (consumer): consumes `certificate.generate`, calls the PDF API through the
 * circuit breaker, schedules retries / dead-letters, evaluates the DLQ alarm.
 * Operational endpoints on WORKER_HTTP_PORT: GET /health, GET /metrics.
 */
const main = async (): Promise<void> => {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ ...config.log, name: 'pdf-worker' });
  let lifecycle: GracefulShutdown | null = null;

  const container = await buildWorkerContainer(config, logger, {
    onConnectionLost: (reason) => {
      if (lifecycle === null) {
        process.exit(1);
      }
      void lifecycle.shutdown(reason, 1);
    },
  });

  if (config.database.migrateOnStart) {
    const applied = await migrateLatest(container.db);
    logger.info({ applied }, 'Database migrations applied');
  }

  const runtime = await startWorkerRuntime(container);
  const server = await listen(runtime.app, config.worker.httpPort);
  logger.info(
    {
      httpPort: config.worker.httpPort,
      prefetch: config.rabbitmq.prefetch,
      retryDelaysMs: container.retryStrategy.delays,
      deferDelayMs: config.worker.deferDelayMs,
      circuitBreaker: config.circuitBreaker,
    },
    'Worker started',
  );

  lifecycle = registerGracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    tasks: [
      // 1. stop consuming + finish in-flight messages (they are acked/nacked normally)
      { name: 'consumer', close: runtime.stop },
      { name: 'http-server', close: () => closeServer(server) },
      // 2. then release the breaker timers, the channel, the connection and the pool
      ...container.shutdownTasks(),
    ],
  });
};

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: failed to start the worker\n${String(error)}\n`);
  process.exit(1);
});
