import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '@application/interfaces/logger';

/** One structured log line per request, written when the response is finished. */
export const requestLogger =
  (logger: Logger) =>
  (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = performance.now();
    response.on('finish', () => {
      const context = {
        method: request.method,
        path: request.originalUrl,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (response.statusCode >= 500) {
        logger.error(context, 'HTTP request');
      } else if (request.path !== '/health') {
        logger.info(context, 'HTTP request');
      }
    });
    next();
  };
