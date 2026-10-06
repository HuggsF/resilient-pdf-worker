import type { Request, Response } from 'express';
import type { ReprocessDlqUseCase } from '@application/use-cases/reprocess-dlq.use-case';
import { toHttpError } from '@presentation/http/errors/error-mapper';
import { reprocessDlqBodySchema } from '@presentation/http/schemas/certificate.schemas';
import { validate } from '@presentation/http/schemas/validate';

export class DlqController {
  constructor(private readonly reprocessDlq: Pick<ReprocessDlqUseCase, 'execute'>) {}

  /** POST /api/dlq/reprocess `{ "limit": 100 }` (body optional) */
  reprocess = async (request: Request, response: Response): Promise<void> => {
    const body = validate(reprocessDlqBodySchema, request.body ?? {});

    const result = await this.reprocessDlq.execute(body);
    if (!result.success) {
      throw toHttpError(result.error);
    }
    response.status(200).json(result.data);
  };
}
