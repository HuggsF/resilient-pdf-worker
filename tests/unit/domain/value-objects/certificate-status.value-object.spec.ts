import { InvalidCertificateStatusError } from '@domain/errors/invalid-certificate-status.error';
import {
  CERTIFICATE_STATUSES,
  canTransition,
  emptyStatusCounts,
  isCertificateStatus,
  parseCertificateStatus,
} from '@domain/value-objects/certificate-status.value-object';
import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';

describe('CertificateStatus', () => {
  it('has exactly the five statuses of the database ENUM', () => {
    expect(CERTIFICATE_STATUSES).toEqual([
      'pending',
      'processing',
      'completed',
      'failed',
      'dead_letter',
    ]);
  });

  it('parses known statuses and rejects anything else', () => {
    expect(parseCertificateStatus('dead_letter')).toEqual({ success: true, data: 'dead_letter' });
    expect(isCertificateStatus('done')).toBe(false);

    const invalid = parseCertificateStatus('done');
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error).toBeInstanceOf(InvalidCertificateStatusError);
      expect(invalid.error.message).toBe('"done" is not a valid certificate status');
    }
  });

  it.each<[CertificateStatus, CertificateStatus, boolean]>([
    ['pending', 'processing', true],
    ['processing', 'completed', true],
    ['processing', 'failed', true],
    ['processing', 'processing', true],
    ['failed', 'processing', true],
    ['failed', 'dead_letter', true],
    ['dead_letter', 'pending', true],
    ['pending', 'completed', false],
    ['failed', 'completed', false],
    ['dead_letter', 'processing', false],
    ['completed', 'processing', false],
    ['completed', 'pending', false],
  ])('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it('builds a zeroed count for every status', () => {
    expect(emptyStatusCounts()).toEqual({
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    });
  });
});
