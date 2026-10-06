import { Certificate } from '@domain/entities/certificate.entity';
import type { CertificateSnapshot } from '@domain/entities/certificate.entity';
import { CertificateAlreadyCompletedError } from '@domain/errors/certificate-already-completed.error';
import { InvalidCertificateStateError } from '@domain/errors/invalid-certificate-state.error';
import { InvalidCertificateStatusError } from '@domain/errors/invalid-certificate-status.error';
import { InvalidCertificateTransitionError } from '@domain/errors/invalid-certificate-transition.error';
import { InvalidCertificateError } from '@domain/errors/invalid-certificate.error';
import { InvalidPdfUrlError } from '@domain/errors/invalid-pdf-url.error';
import { CERTIFICATE_ID, aCertificate, inState, validProps } from '../../../support/fakes';

const AT = new Date('2026-03-01T12:30:00.000Z');
const PDF_URL = 'https://cdn.example.edu/certificates/abc.pdf';

describe('Certificate', () => {
  describe('create', () => {
    it('creates a pending certificate with no attempts', () => {
      const result = Certificate.create(validProps({ studentName: '  Ana   Souza ' }));

      expect(result.success).toBe(true);
      if (!result.success) return;
      const certificate = result.data;
      expect(certificate).toMatchObject({
        id: CERTIFICATE_ID,
        studentId: 'student-42',
        status: 'pending',
        pdfUrl: null,
        attempts: 0,
        lastError: null,
      });
      expect(certificate.studentName.value).toBe('Ana Souza');
      expect(certificate.courseName.value).toBe('Node.js Advanced');
      expect(certificate.completionDate.value).toBe('2026-02-20');
      expect(certificate.createdAt).toEqual(new Date('2026-03-01T10:00:00.000Z'));
      expect(certificate.updatedAt).toEqual(certificate.createdAt);
      expect(certificate.isCompleted).toBe(false);
    });

    it('reports every invalid field at once', () => {
      const result = Certificate.create(
        validProps({
          id: ' ',
          studentId: 'x'.repeat(37),
          studentName: 'A',
          courseName: '',
          completionDate: '2026-02-30',
        }),
      );

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(InvalidCertificateError);
      expect(result.error.code).toBe('INVALID_CERTIFICATE');
      expect(result.error.violations.map((violation) => violation.field)).toEqual([
        'id',
        'studentId',
        'studentName',
        'courseName',
        'completionDate',
      ]);
      expect(result.error.message).toContain('Certificate id is required');
      expect(result.error.message).toContain('Student id must be at most 36 characters');
    });

    it('rejects a completion date in the future', () => {
      const result = Certificate.create(validProps({ completionDate: '2026-03-05' }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.violations[0]?.message).toBe('Completion date cannot be in the future');
      }
    });

    it('rejects an empty student id', () => {
      const result = Certificate.create(validProps({ studentId: '' }));

      expect(!result.success && result.error.violations[0]?.message).toBe('Student id is required');
    });
  });

  describe('state transitions (immutable)', () => {
    it('pending → processing counts an attempt and returns a new instance', () => {
      const pending = aCertificate();

      const result = pending.markAsProcessing(AT);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).not.toBe(pending);
      expect(result.data.status).toBe('processing');
      expect(result.data.attempts).toBe(1);
      expect(result.data.updatedAt).toEqual(AT);
      expect(pending.status).toBe('pending');
      expect(pending.attempts).toBe(0);
      expect(Object.isFrozen(result.data)).toBe(true);
    });

    it('processing → completed stores the PDF URL', () => {
      const processing = inState(aCertificate(), 'processing');

      const result = processing.markAsCompleted(` ${PDF_URL} `, AT);

      expect(result.success && result.data.pdfUrl).toBe(PDF_URL);
      expect(result.success && result.data.isCompleted).toBe(true);
    });

    it.each([
      ['not-a-url', 'absolute http(s) URL'],
      ['ftp://files.example.edu/a.pdf', 'absolute http(s) URL'],
      [`https://cdn.example.edu/${'a'.repeat(500)}.pdf`, 'at most 500 characters'],
    ])('refuses to complete with an invalid PDF URL %p', (url, reason) => {
      const result = inState(aCertificate(), 'processing').markAsCompleted(url, AT);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(InvalidPdfUrlError);
        expect(result.error.message).toContain(reason);
      }
    });

    it('processing → failed records the (bounded) error', () => {
      const result = inState(aCertificate(), 'processing').markAsFailed('x'.repeat(5000), AT);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.status).toBe('failed');
      expect(result.data.attempts).toBe(1);
      expect(result.data.lastError).toHaveLength(Certificate.MAX_ERROR_LENGTH);
      expect(result.data.lastError?.endsWith('…')).toBe(true);
    });

    it('stores a placeholder when the error message is blank', () => {
      const result = inState(aCertificate(), 'processing').markAsFailed('  ', AT);

      expect(result.success && result.data.lastError).toBe('Unknown error');
    });

    it('failed → processing is a new attempt (retry)', () => {
      const failed = inState(aCertificate(), 'processing', 'failed');

      const result = failed.markAsProcessing(AT);

      expect(result.success && result.data.attempts).toBe(2);
    });

    it('a redelivered message may start a new attempt while still processing', () => {
      const result = inState(aCertificate(), 'processing').markAsProcessing(AT);

      expect(result.success && result.data.attempts).toBe(2);
    });

    it('failed → dead_letter keeps the attempts and stores the reason', () => {
      const failed = inState(aCertificate(), 'processing', 'failed');

      const result = failed.markAsDeadLetter('Gave up after 4 attempts', AT);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.status).toBe('dead_letter');
      expect(result.data.attempts).toBe(1);
      expect(result.data.lastError).toBe('Gave up after 4 attempts');
    });

    it('dead-lettering is idempotent', () => {
      const dead = inState(aCertificate(), 'dead_letter');

      const result = dead.markAsDeadLetter('again', AT);

      expect(result.success && result.data).toBe(dead);
    });

    it.each(['dead_letter', 'failed', 'processing'] as const)(
      'requeue from %s resets the retry budget and keeps the last error',
      (state) => {
        const steps =
          state === 'dead_letter'
            ? (['processing', 'failed', 'dead_letter'] as const)
            : state === 'failed'
              ? (['processing', 'failed'] as const)
              : (['processing'] as const);
        const certificate = inState(aCertificate(), ...steps);

        const result = certificate.requeue(AT);

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.status).toBe('pending');
        expect(result.data.attempts).toBe(0);
        expect(result.data.lastError).toBe(certificate.lastError);
      },
    );

    it('a completed certificate is final: no transition is allowed', () => {
      const completed = inState(aCertificate(), 'processing', 'completed');

      const results = [
        completed.markAsProcessing(AT),
        completed.markAsCompleted(PDF_URL, AT),
        completed.markAsFailed('boom', AT),
        completed.markAsDeadLetter('boom', AT),
        completed.requeue(AT),
      ];

      for (const result of results) {
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeInstanceOf(CertificateAlreadyCompletedError);
          expect(result.error.code).toBe('CERTIFICATE_ALREADY_COMPLETED');
        }
      }
    });

    it.each([
      ['pending', 'markAsCompleted'],
      ['pending', 'markAsFailed'],
      ['dead_letter', 'markAsProcessing'],
      ['failed', 'markAsFailed'],
    ] as const)('refuses an invalid transition from %s (%s)', (state, method) => {
      const certificate =
        state === 'pending'
          ? aCertificate()
          : state === 'failed'
            ? inState(aCertificate(), 'processing', 'failed')
            : inState(aCertificate(), 'dead_letter');

      const result =
        method === 'markAsCompleted'
          ? certificate.markAsCompleted(PDF_URL, AT)
          : method === 'markAsFailed'
            ? certificate.markAsFailed('boom', AT)
            : certificate.markAsProcessing(AT);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(InvalidCertificateTransitionError);
        expect(result.error.message).toContain(`from "${state}"`);
      }
    });
  });

  describe('canRetry', () => {
    it('allows attempts while below the maximum', () => {
      const once = inState(aCertificate(), 'processing', 'failed');
      const fourTimes = inState(
        aCertificate(),
        'processing',
        'failed',
        'processing',
        'failed',
        'processing',
        'failed',
        'processing',
        'failed',
      );

      expect(once.canRetry(4)).toBe(true);
      expect(fourTimes.attempts).toBe(4);
      expect(fourTimes.canRetry(4)).toBe(false);
      expect(fourTimes.canRetry(5)).toBe(true);
    });

    it('never retries a final certificate', () => {
      expect(inState(aCertificate(), 'processing', 'completed').canRetry(10)).toBe(false);
      expect(inState(aCertificate(), 'dead_letter').canRetry(10)).toBe(false);
    });
  });

  describe('snapshot / restore', () => {
    const snapshot = (overrides: Partial<CertificateSnapshot> = {}): CertificateSnapshot => ({
      ...inState(aCertificate(), 'processing', 'failed').toSnapshot(),
      ...overrides,
    });

    it('round-trips every field', () => {
      const original = inState(aCertificate(), 'processing', 'failed');

      const restored = Certificate.restore(original.toSnapshot());

      expect(restored.success).toBe(true);
      if (restored.success) {
        expect(restored.data.toSnapshot()).toEqual(original.toSnapshot());
      }
    });

    it('does not re-check the "not in the future" creation rule', () => {
      const restored = Certificate.restore(
        snapshot({ completionDate: '2030-01-01', createdAt: new Date('2026-01-01T00:00:00Z') }),
      );

      expect(restored.success).toBe(true);
    });

    it.each([
      [{ status: 'done' }, InvalidCertificateStatusError],
      [{ attempts: -1 }, InvalidCertificateStateError],
      [{ attempts: 1.5 }, InvalidCertificateStateError],
      [{ status: 'completed', pdfUrl: null }, InvalidCertificateStateError],
      [{ studentName: '' }, InvalidCertificateError],
    ])('rejects a corrupted row %p', (overrides, errorType) => {
      const restored = Certificate.restore(snapshot(overrides));

      expect(restored.success).toBe(false);
      if (!restored.success) {
        expect(restored.error).toBeInstanceOf(errorType);
      }
    });
  });
});
