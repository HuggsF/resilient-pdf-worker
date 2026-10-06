import type { Request, Response } from 'express';
import type { CheckHealthUseCase } from '@application/use-cases/check-health.use-case';

export class HealthController {
  constructor(private readonly checkHealth: Pick<CheckHealthUseCase, 'execute'>) {}

  /**
   * GET /health — 200 when serving (`ok`, or `degraded` = only a non-critical dependency such
   * as the PDF API is down), 503 when a critical dependency (MySQL, RabbitMQ) is down.
   */
  check = async (_request: Request, response: Response): Promise<void> => {
    const result = await this.checkHealth.execute();
    if (!result.success) {
      response.status(503).json({ status: 'down' });
      return;
    }
    response.status(result.data.status === 'down' ? 503 : 200).json(result.data);
  };
}
