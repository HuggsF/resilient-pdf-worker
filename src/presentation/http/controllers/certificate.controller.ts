import type { Request, Response } from 'express';
import type { EnqueueCertificateUseCase } from '@application/use-cases/enqueue-certificate.use-case';
import type { GetCertificateStatsUseCase } from '@application/use-cases/get-certificate-stats.use-case';
import type { GetCertificateStatusUseCase } from '@application/use-cases/get-certificate-status.use-case';
import { toHttpError } from '@presentation/http/errors/error-mapper';
import {
  certificateIdParamsSchema,
  enqueueCertificateBodySchema,
} from '@presentation/http/schemas/certificate.schemas';
import { validate } from '@presentation/http/schemas/validate';

/** Thin adapter: validate input → call one use case → map the Result to HTTP. */
export class CertificateController {
  constructor(
    private readonly enqueueCertificate: Pick<EnqueueCertificateUseCase, 'execute'>,
    private readonly getCertificateStatus: Pick<GetCertificateStatusUseCase, 'execute'>,
    private readonly getCertificateStats: Pick<GetCertificateStatsUseCase, 'execute'>,
  ) {}

  /** POST /api/certificates → 202 Accepted: generation happens asynchronously in the worker. */
  enqueue = async (request: Request, response: Response): Promise<void> => {
    const body = validate(enqueueCertificateBodySchema, request.body);

    const result = await this.enqueueCertificate.execute(body);
    if (!result.success) {
      throw toHttpError(result.error);
    }

    const statusUrl = `/api/certificates/${result.data.certificateId}`;
    response
      .status(202)
      .location(statusUrl)
      .json({ ...result.data, statusUrl });
  };

  /** GET /api/certificates/:id */
  getById = async (request: Request, response: Response): Promise<void> => {
    const { id } = validate(certificateIdParamsSchema, request.params);

    const result = await this.getCertificateStatus.execute({ certificateId: id });
    if (!result.success) {
      throw toHttpError(result.error);
    }
    response.status(200).json(result.data);
  };

  /** GET /api/certificates/stats */
  stats = async (_request: Request, response: Response): Promise<void> => {
    const result = await this.getCertificateStats.execute();
    if (!result.success) {
      throw toHttpError(result.error);
    }
    response.status(200).json(result.data);
  };
}
