import type {
  CertificateOutput,
  GetCertificateStatusInput,
} from '@application/dtos/certificate.dto';
import { CertificateNotFoundError } from '@application/errors/certificate-not-found.error';
import { UnexpectedError } from '@application/errors/unexpected.error';
import { toCertificateOutput } from '@application/services/certificate.mapper';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

export class GetCertificateStatusUseCase {
  constructor(private readonly repository: CertificateRepository) {}

  async execute(
    input: GetCertificateStatusInput,
  ): Promise<Result<CertificateOutput, CertificateNotFoundError | UnexpectedError>> {
    try {
      const certificate = await this.repository.findById(input.certificateId);
      if (certificate === null) {
        return fail(new CertificateNotFoundError(input.certificateId));
      }
      return ok(toCertificateOutput(certificate));
    } catch (error: unknown) {
      return fail(new UnexpectedError('Loading the certificate', error));
    }
  }
}
