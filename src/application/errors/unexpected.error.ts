import { ApplicationError } from './application.error';

/** Wraps an unanticipated infrastructure exception so use cases can still return a Result. */
export class UnexpectedError extends ApplicationError {
  readonly code = 'UNEXPECTED_ERROR';

  constructor(operation: string, cause: unknown) {
    super(
      `${operation} failed unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
