import { InvalidJobMessageError } from '@application/errors/invalid-job-message.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

/**
 * The queue message is a *claim check*: only the certificate id travels through RabbitMQ, the
 * certificate itself lives in MySQL (single source of truth, no stale data in old messages).
 */
export type CertificateJob = {
  readonly certificateId: string;
};

const SCHEMA_VERSION = 1;
const MAX_ID_LENGTH = 36;

export const encodeCertificateJob = (job: CertificateJob): Buffer =>
  Buffer.from(JSON.stringify({ version: SCHEMA_VERSION, certificateId: job.certificateId }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const decodeCertificateJob = (
  content: Buffer,
): Result<CertificateJob, InvalidJobMessageError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    return fail(new InvalidJobMessageError('body is not valid JSON'));
  }
  if (!isRecord(parsed)) {
    return fail(new InvalidJobMessageError('body must be a JSON object'));
  }
  const { certificateId, version } = parsed;
  if (version !== SCHEMA_VERSION) {
    return fail(new InvalidJobMessageError(`unsupported version ${String(version)}`));
  }
  if (
    typeof certificateId !== 'string' ||
    certificateId.trim() === '' ||
    certificateId.length > MAX_ID_LENGTH
  ) {
    return fail(new InvalidJobMessageError('certificateId must be a non-empty string'));
  }
  return ok({ certificateId });
};
