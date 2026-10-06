import { InvalidJobMessageError } from '@application/errors/invalid-job-message.error';
import { PdfGenerationError } from '@application/errors/pdf-generation.error';
import {
  decodeCertificateJob,
  encodeCertificateJob,
} from '@application/services/certificate-job.codec';
import { CERTIFICATE_QUEUES, retryQueueName } from '@application/services/certificate-queues';
import { toPdfGenerationData } from '@application/services/certificate.mapper';
import { CERTIFICATE_ID, aCertificate } from '../../../support/fakes';

describe('certificate job codec', () => {
  it('round-trips a job', () => {
    const encoded = encodeCertificateJob({ certificateId: CERTIFICATE_ID });

    expect(decodeCertificateJob(encoded)).toEqual({
      success: true,
      data: { certificateId: CERTIFICATE_ID },
    });
  });

  it.each([
    ['{', 'not valid JSON'],
    ['"text"', 'must be a JSON object'],
    ['null', 'must be a JSON object'],
    ['{"version":3,"certificateId":"a"}', 'unsupported version 3'],
    ['{"version":1,"certificateId":""}', 'non-empty string'],
    ['{"version":1,"certificateId":42}', 'non-empty string'],
    [`{"version":1,"certificateId":"${'x'.repeat(37)}"}`, 'non-empty string'],
  ])('rejects %p', (body, reason) => {
    const result = decodeCertificateJob(Buffer.from(body));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(InvalidJobMessageError);
      expect(result.error.message).toContain(reason);
    }
  });
});

describe('certificate queues', () => {
  it('names the queues of the SPEC topology', () => {
    expect(CERTIFICATE_QUEUES).toEqual({
      generate: 'certificate.generate',
      deadLetter: 'certificate.dlq',
      retryPrefix: 'certificate.retry',
    });
  });

  it.each([
    [1000, 'certificate.retry.1s'],
    [16_000, 'certificate.retry.16s'],
    [250, 'certificate.retry.250ms'],
    [1500, 'certificate.retry.1500ms'],
  ])('names the %i ms retry queue %p', (delay, name) => {
    expect(retryQueueName(delay)).toBe(name);
  });
});

describe('PdfGenerationError', () => {
  it.each([
    ['server_error', true, true],
    ['timeout', true, true],
    ['circuit_open', true, false],
    ['rejected', false, true],
  ] as const)('%s → retryable %s, attempted %s', (kind, retryable, attempted) => {
    const error = new PdfGenerationError(kind, 'boom', 500);

    expect(error.retryable).toBe(retryable);
    expect(error.attempted).toBe(attempted);
    expect(error.code).toBe('PDF_GENERATION_FAILED');
  });
});

describe('certificate mapper', () => {
  it('maps a certificate to the PDF API payload', () => {
    expect(toPdfGenerationData(aCertificate())).toEqual({
      certificateId: CERTIFICATE_ID,
      studentId: 'student-42',
      studentName: 'Ana Souza',
      courseName: 'Node.js Advanced',
      completionDate: '2026-02-20',
    });
  });
});
