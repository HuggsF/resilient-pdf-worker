import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '@application/interfaces/logger';
import { HttpError } from '@presentation/http/errors/http-error';
import type { ErrorResponseBody } from '@presentation/http/errors/http-error';

/** Errors raised by Express / body-parser (malformed JSON, payload too large…) carry a status. */
const hasClientErrorStatus = (error: unknown): error is { status: number; type?: unknown } =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'number' &&
  error.status >= 400 &&
  error.status < 500;

const clientErrorBody = (error: { status: number; type?: unknown }): ErrorResponseBody => {
  if (error.type === 'entity.parse.failed') {
    return { error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' } };
  }
  if (error.status === 413) {
    return { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } };
  }
  if (error.status === 415) {
    return { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type' } };
  }
  return { error: { code: 'BAD_REQUEST', message: 'Bad request' } };
};

/** Last middleware: every error becomes a JSON body; internals are logged, never leaked. */
export const errorHandler =
  (logger: Logger) =>
  (error: unknown, request: Request, response: Response, _next: NextFunction): void => {
    if (error instanceof HttpError) {
      if (error.status >= 500) {
        logger.error({ err: error, path: request.path }, 'Request failed');
      }
      const body: ErrorResponseBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      response.status(error.status).set(error.headers).json(body);
      return;
    }
    if (hasClientErrorStatus(error)) {
      response.status(error.status).json(clientErrorBody(error));
      return;
    }

    logger.error({ err: error, method: request.method, path: request.path }, 'Unhandled error');
    response
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  };
