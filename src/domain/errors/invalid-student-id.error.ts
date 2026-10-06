import { FieldValidationError } from './domain.error';

export class InvalidStudentIdError extends FieldValidationError {
  readonly code = 'INVALID_STUDENT_ID';

  constructor(value: string, reason: string) {
    super('studentId', value, reason);
  }
}
