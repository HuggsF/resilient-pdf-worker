import type { PdfGenerationError } from '@application/errors/pdf-generation.error';
import type { Result } from '@domain/shared/result';

export type PdfGenerationData = {
  /** Also sent as the idempotency key: the same certificate always maps to the same PDF. */
  readonly certificateId: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly courseName: string;
  /** `YYYY-MM-DD` */
  readonly completionDate: string;
};

/** Port: the external PDF generation API (HTTP client behind a circuit breaker). */
export interface PdfGeneratorService {
  /** Resolves with the URL of the generated PDF. Never throws: failures are typed. */
  generate(data: PdfGenerationData): Promise<Result<string, PdfGenerationError>>;
}
