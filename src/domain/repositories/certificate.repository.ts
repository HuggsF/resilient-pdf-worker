import type { Certificate } from '@domain/entities/certificate.entity';
import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';

/** Port: persistence of certificates (implemented with MySQL 8 in Infrastructure). */
export interface CertificateRepository {
  /** Insert or update (upsert by id) the whole certificate. */
  save(certificate: Certificate): Promise<void>;
  findById(id: string): Promise<Certificate | null>;
  /** Oldest first, bounded by `limit` (default 100). */
  findByStatus(status: CertificateStatus, limit?: number): Promise<Certificate[]>;
  /** Targeted status change for operational tooling (does not touch `attempts`). */
  updateStatus(
    id: string,
    status: CertificateStatus,
    pdfUrl?: string,
    error?: string,
  ): Promise<void>;
  /** A count for every status, zero included. */
  countByStatus(): Promise<Record<CertificateStatus, number>>;
}
