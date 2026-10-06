import { InvalidCertificateStatusError } from '@domain/errors/invalid-certificate-status.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

export const CERTIFICATE_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'dead_letter',
] as const;

/**
 * Lifecycle of a certificate:
 *
 *   pending ──► processing ──► completed                 (final)
 *                  │  ▲
 *                  ▼  │ retry after backoff
 *                failed ──► dead_letter ──► pending      (DLQ reprocess)
 */
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<CertificateStatus, readonly CertificateStatus[]>> = {
  // `pending → pending` keeps a DLQ reprocess idempotent.
  pending: ['processing', 'dead_letter', 'pending'],
  // `processing → processing`: a message redelivered after a worker crash starts a new attempt.
  processing: ['completed', 'failed', 'dead_letter', 'processing', 'pending'],
  failed: ['processing', 'dead_letter', 'pending'],
  dead_letter: ['pending'],
  completed: [],
};

export const isCertificateStatus = (value: string): value is CertificateStatus =>
  (CERTIFICATE_STATUSES as readonly string[]).includes(value);

export const parseCertificateStatus = (
  value: string,
): Result<CertificateStatus, InvalidCertificateStatusError> =>
  isCertificateStatus(value) ? ok(value) : fail(new InvalidCertificateStatusError(value));

export const canTransition = (from: CertificateStatus, to: CertificateStatus): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);

/** A record with a zero for every status — the shape of "count by status" reports. */
export const emptyStatusCounts = (): Record<CertificateStatus, number> => ({
  pending: 0,
  processing: 0,
  completed: 0,
  failed: 0,
  dead_letter: 0,
});
