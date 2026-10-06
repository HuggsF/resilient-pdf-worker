import express from 'express';
import type { Express, Request, Response } from 'express';
import type { Logger } from '@application/interfaces/logger';
import type { HealthController } from '@presentation/http/controllers/health.controller';
import { errorHandler } from '@presentation/http/middleware/error-handler.middleware';
import { notFoundHandler } from '@presentation/http/middleware/not-found.middleware';
import { buildHealthRouter } from '@presentation/http/routes/health.routes';

export type WorkerHttpDependencies = {
  readonly healthController: HealthController;
  /** Live snapshot for GET /metrics (counters, circuit breaker, alarms). */
  readonly metrics: () => unknown;
  readonly logger: Logger;
};

/** Operational endpoints of the worker process (container healthcheck + metrics). */
export const createWorkerHttpApp = (dependencies: WorkerHttpDependencies): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(buildHealthRouter(dependencies.healthController));
  app.get('/metrics', (_request: Request, response: Response) => {
    response.status(200).json(dependencies.metrics());
  });
  app.use(notFoundHandler);
  app.use(errorHandler(dependencies.logger));
  return app;
};
