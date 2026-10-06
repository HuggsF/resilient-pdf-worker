import type { z } from 'zod';
import { HttpError } from '@presentation/http/errors/http-error';

/** Parses untrusted input with zod or throws a 400 listing every issue. */
export const validate = <S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return parsed.data as z.infer<S>;
};
