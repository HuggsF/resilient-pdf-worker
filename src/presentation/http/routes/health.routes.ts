import { Router } from 'express';
import type { HealthController } from '@presentation/http/controllers/health.controller';

export const buildHealthRouter = (controller: HealthController): Router => {
  const router = Router();
  router.get('/health', controller.check);
  return router;
};
