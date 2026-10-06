import './module-aliases';
import { buildApiContainer } from '@infrastructure/config/container';
import { loadConfig, loadEnvFile } from '@infrastructure/config/env';
import { migrateLatest } from '@infrastructure/database/migrator';
import { registerGracefulShutdown } from '@infrastructure/lifecycle/graceful-shutdown';
import type { GracefulShutdown } from '@infrastructure/lifecycle/graceful-shutdown';
import { createLogger } from '@infrastructure/logging/logger';
import { buildHttpApp, closeServer, listen } from '@presentation/http/server';

/**
 * HTTP API process (producer): POST /api/certificates, GET /api/certificates/:id,
 * GET /api/certificates/stats, POST /api/dlq/reprocess, GET /health.
 */
const main = async (): Promise<void> => {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ ...config.log, name: 'pdf-api' });
  let lifecycle: GracefulShutdown | null = null;

  const container = await buildApiContainer(config, logger, {
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

  const server = await listen(buildHttpApp(container), config.http.port);
  logger.info({ port: config.http.port, env: config.env }, 'HTTP API listening');

  lifecycle = registerGracefulShutdown({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    tasks: [
      { name: 'http-server', close: () => closeServer(server) },
      ...container.shutdownTasks(),
    ],
  });
};

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: failed to start the HTTP API\n${String(error)}\n`);
  process.exit(1);
});
