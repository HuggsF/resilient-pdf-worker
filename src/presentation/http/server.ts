import type { Server } from 'node:http';
import type { Express } from 'express';
import type { ApiContainer } from '@infrastructure/config/container';
import { createHttpApp } from '@presentation/http/app';
import { CertificateController } from '@presentation/http/controllers/certificate.controller';
import { DlqController } from '@presentation/http/controllers/dlq.controller';
import { HealthController } from '@presentation/http/controllers/health.controller';

/** Wires controllers to the use cases exposed by the API container. */
export const buildHttpApp = (container: ApiContainer): Express =>
  createHttpApp({
    logger: container.logger,
    healthController: new HealthController(container.checkHealth),
    certificateController: new CertificateController(
      container.enqueueCertificate,
      container.getCertificateStatus,
      container.getCertificateStats,
    ),
    dlqController: new DlqController(container.reprocessDlq),
  });

export const listen = (app: Express, port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = app.listen(port, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(server);
    });
  });

/** Stops accepting connections and resolves once in-flight requests are done. */
export const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });
