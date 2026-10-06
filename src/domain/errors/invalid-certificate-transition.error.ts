import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';
import { DomainError } from './domain.error';

export class InvalidCertificateTransitionError extends DomainError {
  readonly code = 'INVALID_CERTIFICATE_TRANSITION';

  constructor(
    readonly certificateId: string,
    readonly from: CertificateStatus,
    readonly to: CertificateStatus,
  ) {
    super(`Certificate ${certificateId} cannot move from "${from}" to "${to}"`);
  }
}
