import { FieldValidationError } from './domain.error';

export class InvalidCertificateStatusError extends FieldValidationError {
  readonly code = 'INVALID_CERTIFICATE_STATUS';

  constructor(value: string) {
    super('status', value, `"${value}" is not a valid certificate status`);
  }
}
