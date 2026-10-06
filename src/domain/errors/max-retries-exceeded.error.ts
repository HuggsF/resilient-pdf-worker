import { DomainError } from './domain.error';

export class MaxRetriesExceededError extends DomainError {
  readonly code = 'MAX_RETRIES_EXCEEDED';

  constructor(
    readonly certificateId: string,
    readonly attempts: number,
    readonly maxAttempts: number,
  ) {
    super(
      `Certificate ${certificateId} failed ${attempts} of ${maxAttempts} allowed attempts: giving up`,
    );
  }
}
