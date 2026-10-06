import { InvalidCourseNameError } from '@domain/errors/invalid-course-name.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

/** Control characters (NUL, escape sequences…) would corrupt the PDF layout. */
const CONTROL_CHARACTERS = /\p{Cc}/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The course title printed on the certificate (e.g. "Node.js Advanced", "C++ 101"). */
export class CourseName {
  static readonly MIN_LENGTH = 2;
  static readonly MAX_LENGTH = 200;

  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  /** Trims the title and collapses inner whitespace (incl. line breaks) before validating it. */
  static create(raw: string): Result<CourseName, InvalidCourseNameError> {
    const normalized = raw.trim().replace(/\s+/g, ' ');

    if (CONTROL_CHARACTERS.test(normalized)) {
      return fail(
        new InvalidCourseNameError(raw, 'Course name must not contain control characters'),
      );
    }
    if (normalized.length < CourseName.MIN_LENGTH) {
      return fail(
        new InvalidCourseNameError(
          raw,
          `Course name must be at least ${CourseName.MIN_LENGTH} characters`,
        ),
      );
    }
    if (normalized.length > CourseName.MAX_LENGTH) {
      return fail(
        new InvalidCourseNameError(
          raw,
          `Course name must be at most ${CourseName.MAX_LENGTH} characters`,
        ),
      );
    }
    if (!HAS_LETTER_OR_DIGIT.test(normalized)) {
      return fail(new InvalidCourseNameError(raw, 'Course name must contain a letter or a digit'));
    }
    return ok(new CourseName(normalized));
  }

  equals(other: CourseName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
