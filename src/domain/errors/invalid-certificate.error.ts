import { DomainError } from './domain.error';
import type { FieldValidationError } from './domain.error';

/** Every field rule violated by a certificate request, reported at once. */
export class InvalidCertificateError extends DomainError {
  readonly code = 'INVALID_CERTIFICATE';

  constructor(readonly violations: readonly FieldValidationError[]) {
    super(`Invalid certificate: ${violations.map((violation) => violation.message).join('; ')}`);
  }
}
