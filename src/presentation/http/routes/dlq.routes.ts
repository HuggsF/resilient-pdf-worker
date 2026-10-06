import { Router } from 'express';
import type { DlqController } from '@presentation/http/controllers/dlq.controller';

export const buildDlqRouter = (controller: DlqController): Router => {
  const router = Router();
  router.post('/reprocess', controller.reprocess);
  return router;
};
