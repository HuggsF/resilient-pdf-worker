import { DomainError } from './domain.error';

export class InvalidRetryStrategyError extends DomainError {
  readonly code = 'INVALID_RETRY_STRATEGY';

  constructor(reason: string) {
    super(`Invalid retry strategy: ${reason}`);
  }
}
