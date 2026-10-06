import { FieldValidationError } from './domain.error';

export class InvalidPdfUrlError extends FieldValidationError {
  readonly code = 'INVALID_PDF_URL';

  constructor(value: string, reason: string) {
    super('pdfUrl', value, reason);
  }
}
