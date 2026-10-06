import { InvalidCourseNameError } from '@domain/errors/invalid-course-name.error';
import { CourseName } from '@domain/value-objects/course-name.value-object';

describe('CourseName', () => {
  it.each([
    ['Node.js Advanced', 'Node.js Advanced'],
    ['C++ 101', 'C++ 101'],
    ['  Clean   Architecture\nin TypeScript ', 'Clean Architecture in TypeScript'],
    ['AI', 'AI'],
    ['42', '42'],
  ])('accepts %p and normalizes it to %p', (raw, expected) => {
    const result = CourseName.create(raw);

    expect(result.success && result.data.value).toBe(expected);
  });

  it.each([
    ['', 'at least 2 characters'],
    ['X', 'at least 2 characters'],
    ['x'.repeat(201), 'at most 200 characters'],
    ['--', 'must contain a letter or a digit'],
    [`Node${String.fromCharCode(0)}js`, 'control characters'],
  ])('rejects %p (%s)', (raw, reason) => {
    const result = CourseName.create(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InvalidCourseNameError);
      expect(result.error.code).toBe('INVALID_COURSE_NAME');
      expect(result.error.field).toBe('courseName');
      expect(result.error.message).toContain(reason);
    }
  });

  it('accepts exactly 200 characters', () => {
    expect(CourseName.create('c'.repeat(200)).success).toBe(true);
  });

  it('is compared by value', () => {
    const a = CourseName.create('Node.js');
    const b = CourseName.create('Node.js ');
    if (!a.success || !b.success) throw new Error('expected valid course names');

    expect(a.data.equals(b.data)).toBe(true);
    expect(a.data.toString()).toBe('Node.js');
    expect(Object.isFrozen(a.data)).toBe(true);
  });
});
