import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';

export type EnqueueCertificateInput = {
  readonly studentId: string;
  readonly studentName: string;
  readonly courseName: string;
  /** `YYYY-MM-DD`. Defaults to today (UTC). */
  readonly completionDate?: string;
};

export type EnqueueCertificateOutput = {
  readonly certificateId: string;
  readonly status: CertificateStatus;
};

export type GetCertificateStatusInput = {
  readonly certificateId: string;
};

/** Public representation of a certificate (never the entity itself). */
export type CertificateOutput = {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly courseName: string;
  readonly completionDate: string;
  readonly status: CertificateStatus;
  readonly pdfUrl: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type QueueDepthsOutput = {
  readonly generate: number;
  /** Sum of every delayed-retry queue. */
  readonly retry: number;
  readonly deadLetter: number;
};

export type CertificateStatsOutput = {
  readonly total: number;
  readonly byStatus: Readonly<Record<CertificateStatus, number>>;
  /** `null` when the broker could not be reached (the database counts are still returned). */
  readonly queues: QueueDepthsOutput | null;
};
