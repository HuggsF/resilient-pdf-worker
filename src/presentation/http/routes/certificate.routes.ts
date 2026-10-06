import { Router } from 'express';
import type { CertificateController } from '@presentation/http/controllers/certificate.controller';

export const buildCertificateRouter = (controller: CertificateController): Router => {
  const router = Router();
  router.post('/', controller.enqueue);
  // Declared before `/:id` so "stats" is not parsed as an id.
  router.get('/stats', controller.stats);
  router.get('/:id', controller.getById);
  return router;
};
