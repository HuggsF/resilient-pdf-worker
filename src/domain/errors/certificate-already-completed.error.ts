import { DomainError } from './domain.error';

/** A completed certificate is final: its PDF must never be generated twice. */
export class CertificateAlreadyCompletedError extends DomainError {
  readonly code = 'CERTIFICATE_ALREADY_COMPLETED';

  constructor(readonly certificateId: string) {
    super(`Certificate ${certificateId} is already completed`);
  }
}
