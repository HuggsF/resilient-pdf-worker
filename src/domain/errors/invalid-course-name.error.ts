import { FieldValidationError } from './domain.error';

export class InvalidCourseNameError extends FieldValidationError {
  readonly code = 'INVALID_COURSE_NAME';

  constructor(value: string, reason: string) {
    super('courseName', value, reason);
  }
}
