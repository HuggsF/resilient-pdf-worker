import { FieldValidationError } from './domain.error';

export class InvalidCompletionDateError extends FieldValidationError {
  readonly code = 'INVALID_COMPLETION_DATE';

  constructor(value: string, reason: string) {
    super('completionDate', value, reason);
  }
}
