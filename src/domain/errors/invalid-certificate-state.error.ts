import { DomainError } from './domain.error';

/** A persisted certificate breaks an invariant (e.g. completed without a PDF URL). */
export class InvalidCertificateStateError extends DomainError {
  readonly code = 'INVALID_CERTIFICATE_STATE';

  constructor(
    readonly certificateId: string,
    reason: string,
  ) {
    super(`Certificate ${certificateId} is in an invalid state: ${reason}`);
  }
}
