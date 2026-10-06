import { ApplicationError } from './application.error';

export class CertificateNotFoundError extends ApplicationError {
  readonly code = 'CERTIFICATE_NOT_FOUND';

  constructor(readonly certificateId: string) {
    super(`Certificate ${certificateId} was not found`);
  }
}
