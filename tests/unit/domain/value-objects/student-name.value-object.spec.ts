import { InvalidStudentNameError } from '@domain/errors/invalid-student-name.error';
import { StudentName } from '@domain/value-objects/student-name.value-object';

describe('StudentName', () => {
  it.each([
    ['Ana Souza', 'Ana Souza'],
    ['  José   da  Silva ', 'José da Silva'],
    ["Mary O'Brien-Smith", "Mary O'Brien-Smith"],
    ['Jo', 'Jo'],
    ['Martin Luther King Jr.', 'Martin Luther King Jr.'],
    ['Zoë Łukasz', 'Zoë Łukasz'],
  ])('accepts %p and normalizes it to %p', (raw, expected) => {
    const result = StudentName.create(raw);

    expect(result.success && result.data.value).toBe(expected);
  });

  it.each([
    ['', 'at least 2 characters'],
    ['  A  ', 'at least 2 characters'],
    ['x'.repeat(101), 'at most 100 characters'],
    ['Ana 2nd', 'may only contain letters'],
    ['<script>', 'may only contain letters'],
    ["'- .", 'may only contain letters'],
  ])('rejects %p (%s)', (raw, reason) => {
    const result = StudentName.create(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InvalidStudentNameError);
      expect(result.error.code).toBe('INVALID_STUDENT_NAME');
      expect(result.error.field).toBe('studentName');
      expect(result.error.value).toBe(raw);
      expect(result.error.message).toContain(reason);
    }
  });

  it('accepts exactly 100 characters', () => {
    expect(StudentName.create('a'.repeat(100)).success).toBe(true);
  });

  it('is immutable and compared by value', () => {
    const a = StudentName.create('Ana Souza');
    const b = StudentName.create(' Ana  Souza ');
    if (!a.success || !b.success) throw new Error('expected valid names');

    expect(a.data.equals(b.data)).toBe(true);
    expect(String(a.data)).toBe('Ana Souza');
    expect(Object.isFrozen(a.data)).toBe(true);
  });
});
