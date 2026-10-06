import { InvalidStudentNameError } from '@domain/errors/invalid-student-name.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

/** Letters from any alphabet (incl. accents), spaces, dots, hyphens and apostrophes. */
const ALLOWED_CHARACTERS = /^[\p{L}\p{M} .'’-]+$/u;
const HAS_LETTER = /\p{L}/u;

/** The name printed on the certificate. */
export class StudentName {
  static readonly MIN_LENGTH = 2;
  static readonly MAX_LENGTH = 100;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Trims the name and collapses inner whitespace before validating it. */
  static create(raw: string): Result<StudentName, InvalidStudentNameError> {
    const normalized = raw.trim().replace(/\s+/g, ' ');

    if (normalized.length < StudentName.MIN_LENGTH) {
      return fail(
        new InvalidStudentNameError(
          raw,
          `Student name must be at least ${StudentName.MIN_LENGTH} characters`,
        ),
      );
    }
    if (normalized.length > StudentName.MAX_LENGTH) {
      return fail(
        new InvalidStudentNameError(
          raw,
          `Student name must be at most ${StudentName.MAX_LENGTH} characters`,
        ),
      );
    }
    if (!ALLOWED_CHARACTERS.test(normalized) || !HAS_LETTER.test(normalized)) {
      return fail(
        new InvalidStudentNameError(
          raw,
          'Student name may only contain letters, spaces, dots, hyphens and apostrophes',
        ),
      );
    }
    return ok(new StudentName(normalized));
  }

  equals(other: StudentName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
