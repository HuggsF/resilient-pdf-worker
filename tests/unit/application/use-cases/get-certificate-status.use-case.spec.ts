import { CertificateNotFoundError } from '@application/errors/certificate-not-found.error';
import { UnexpectedError } from '@application/errors/unexpected.error';
import { GetCertificateStatusUseCase } from '@application/use-cases/get-certificate-status.use-case';
import {
  CERTIFICATE_ID,
  InMemoryCertificateRepository,
  aCertificate,
  inState,
} from '../../../support/fakes';

describe('GetCertificateStatusUseCase', () => {
  it('returns the certificate as a DTO', async () => {
    const repository = new InMemoryCertificateRepository();
    repository.seed(inState(aCertificate(), 'processing', 'completed'));

    const result = await new GetCertificateStatusUseCase(repository).execute({
      certificateId: CERTIFICATE_ID,
    });

    expect(result).toEqual({
      success: true,
      data: {
        id: CERTIFICATE_ID,
        studentId: 'student-42',
        studentName: 'Ana Souza',
        courseName: 'Node.js Advanced',
        completionDate: '2026-02-20',
        status: 'completed',
        pdfUrl: `https://cdn.example.edu/${CERTIFICATE_ID}.pdf`,
        attempts: 1,
        lastError: null,
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T11:00:00.000Z',
      },
    });
  });

  it('fails with CertificateNotFound for an unknown id', async () => {
    const result = await new GetCertificateStatusUseCase(
      new InMemoryCertificateRepository(),
    ).execute({ certificateId: 'nope' });

    expect(!result.success && result.error).toBeInstanceOf(CertificateNotFoundError);
    expect(!result.success && result.error.message).toBe('Certificate nope was not found');
  });

  it('wraps repository failures', async () => {
    const repository = new InMemoryCertificateRepository();
    repository.failOn('findById');

    const result = await new GetCertificateStatusUseCase(repository).execute({
      certificateId: CERTIFICATE_ID,
    });

    expect(!result.success && result.error).toBeInstanceOf(UnexpectedError);
  });
});
