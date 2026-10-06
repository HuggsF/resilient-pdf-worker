import { InvalidCompletionDateError } from '@domain/errors/invalid-completion-date.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST = '1970-01-01';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A calendar date (no time, no time zone) kept as `YYYY-MM-DD`, exactly like the MySQL `DATE`
 * column. Comparing two ISO dates as strings is equivalent to comparing the dates.
 */
export class CompletionDate {
  private constructor(readonly value: string) {
    Object.freeze(this);
  }

  static create(raw: string): Result<CompletionDate, InvalidCompletionDateError> {
    const value = raw.trim();
    const match = ISO_DATE.exec(value);
    if (match === null) {
      return fail(
        new InvalidCompletionDateError(raw, 'Completion date must be in YYYY-MM-DD format'),
      );
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return fail(
        new InvalidCompletionDateError(raw, 'Completion date is not a valid calendar date'),
      );
    }
    if (value < EARLIEST) {
      return fail(
        new InvalidCompletionDateError(raw, `Completion date must be on or after ${EARLIEST}`),
      );
    }
    return ok(new CompletionDate(value));
  }

  /** The UTC calendar date of an instant (e.g. "today" as the default completion date). */
  static fromInstant(instant: Date): CompletionDate {
    return new CompletionDate(instant.toISOString().slice(0, 10));
  }

  /**
   * True when the date is later than the reference instant's UTC date + 1 day. The extra day
   * tolerates clients in time zones ahead of UTC, whose "today" may already be tomorrow in UTC.
   */
  isAfter(reference: Date): boolean {
    const latestAllowed = new Date(reference.getTime() + DAY_MS).toISOString().slice(0, 10);
    return this.value > latestAllowed;
  }

  equals(other: CompletionDate): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
