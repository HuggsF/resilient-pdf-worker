import type { ApplicationError } from '@application/errors/application.error';
import type { DomainError } from '@domain/errors/domain.error';
import { InvalidCertificateError } from '@domain/errors/invalid-certificate.error';
import { HttpError } from './http-error';

const RETRY_AFTER_SECONDS = '5';

const STATUS_BY_CODE: ReadonlyMap<string, number> = new Map([
  ['CERTIFICATE_NOT_FOUND', 404],
  ['QUEUE_UNAVAILABLE', 503],
]);

/** Translates use-case failures (Result errors) into HTTP semantics. */
export const toHttpError = (error: ApplicationError | DomainError): HttpError => {
  if (error instanceof InvalidCertificateError) {
    return new HttpError(
      400,
      error.code,
      'Invalid certificate request',
      error.violations.map((violation) => ({
        path: violation.field,
        message: violation.message,
      })),
    );
  }
  const status = STATUS_BY_CODE.get(error.code);
  if (status === 503) {
    return new HttpError(503, error.code, error.message, undefined, {
      'Retry-After': RETRY_AFTER_SECONDS,
    });
  }
  return status === undefined
    ? new HttpError(500, 'INTERNAL_ERROR', 'Internal server error')
    : new HttpError(status, error.code, error.message);
};
