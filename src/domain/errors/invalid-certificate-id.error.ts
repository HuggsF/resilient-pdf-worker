import { FieldValidationError } from './domain.error';

export class InvalidCertificateIdError extends FieldValidationError {
  readonly code = 'INVALID_CERTIFICATE_ID';

  constructor(value: string, reason: string) {
    super('id', value, reason);
  }
}
