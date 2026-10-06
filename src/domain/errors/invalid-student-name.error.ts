import { FieldValidationError } from './domain.error';

export class InvalidStudentNameError extends FieldValidationError {
  readonly code = 'INVALID_STUDENT_NAME';

  constructor(value: string, reason: string) {
    super('studentName', value, reason);
  }
}
