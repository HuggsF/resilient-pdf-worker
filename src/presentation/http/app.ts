import express from 'express';
import type { Express } from 'express';
import type { Logger } from '@application/interfaces/logger';
import type { CertificateController } from '@presentation/http/controllers/certificate.controller';
import type { DlqController } from '@presentation/http/controllers/dlq.controller';
import type { HealthController } from '@presentation/http/controllers/health.controller';
import { errorHandler } from '@presentation/http/middleware/error-handler.middleware';
import { notFoundHandler } from '@presentation/http/middleware/not-found.middleware';
import { requestLogger } from '@presentation/http/middleware/request-logger.middleware';
import { buildCertificateRouter } from '@presentation/http/routes/certificate.routes';
import { buildDlqRouter } from '@presentation/http/routes/dlq.routes';
import { buildHealthRouter } from '@presentation/http/routes/health.routes';

export type HttpAppDependencies = {
  readonly certificateController: CertificateController;
  readonly dlqController: DlqController;
  readonly healthController: HealthController;
  readonly logger: Logger;
};

const JSON_BODY_LIMIT = '16kb';

export const createHttpApp = (dependencies: HttpAppDependencies): Express => {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger(dependencies.logger));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(buildHealthRouter(dependencies.healthController));
  app.use('/api/certificates', buildCertificateRouter(dependencies.certificateController));
  app.use('/api/dlq', buildDlqRouter(dependencies.dlqController));

  app.use(notFoundHandler);
  app.use(errorHandler(dependencies.logger));
  return app;
};
