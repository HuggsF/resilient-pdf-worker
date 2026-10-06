import type { Request, Response } from 'express';

export const notFoundHandler = (request: Request, response: Response): void => {
  response.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.path} not found` },
  });
};
