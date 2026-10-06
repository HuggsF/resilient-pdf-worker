import { InvalidCompletionDateError } from '@domain/errors/invalid-completion-date.error';
import { CompletionDate } from '@domain/value-objects/completion-date.value-object';

describe('CompletionDate', () => {
  it.each(['2024-02-29', '1970-01-01', ' 2026-12-31 '])('accepts %p', (raw) => {
    const result = CompletionDate.create(raw);

    expect(result.success && result.data.value).toBe(raw.trim());
  });

  it.each([
    ['2024-02-30', 'not a valid calendar date'],
    ['2023-02-29', 'not a valid calendar date'],
    ['2024-13-01', 'not a valid calendar date'],
    ['15/03/2024', 'YYYY-MM-DD format'],
    ['2024-3-1', 'YYYY-MM-DD format'],
    ['', 'YYYY-MM-DD format'],
    ['1969-12-31', 'on or after 1970-01-01'],
  ])('rejects %p (%s)', (raw, reason) => {
    const result = CompletionDate.create(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InvalidCompletionDateError);
      expect(result.error.field).toBe('completionDate');
      expect(result.error.message).toContain(reason);
    }
  });

  it('derives the UTC calendar date of an instant', () => {
    expect(CompletionDate.fromInstant(new Date('2026-03-01T23:59:59.999Z')).value).toBe(
      '2026-03-01',
    );
  });

  it('is "after" a reference only beyond its UTC date + 1 day (time-zone tolerance)', () => {
    const reference = new Date('2026-03-01T12:00:00.000Z');
    const date = (raw: string): CompletionDate => {
      const result = CompletionDate.create(raw);
      if (!result.success) throw result.error;
      return result.data;
    };

    expect(date('2026-03-01').isAfter(reference)).toBe(false);
    expect(date('2026-03-02').isAfter(reference)).toBe(false);
    expect(date('2026-03-03').isAfter(reference)).toBe(true);
  });

  it('is compared by value', () => {
    const a = CompletionDate.create('2024-01-01');
    const b = CompletionDate.create(' 2024-01-01');
    if (!a.success || !b.success) throw new Error('expected valid dates');

    expect(a.data.equals(b.data)).toBe(true);
    expect(a.data.toString()).toBe('2024-01-01');
  });
});
