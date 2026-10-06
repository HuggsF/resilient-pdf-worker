import type { Knex } from 'knex';
import { Certificate } from '@domain/entities/certificate.entity';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import {
  emptyStatusCounts,
  isCertificateStatus,
} from '@domain/value-objects/certificate-status.value-object';
import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';

export const CERTIFICATES_TABLE = 'certificates';

const DEFAULT_LIMIT = 100;

export type CertificateRow = {
  id: string;
  student_id: string;
  student_name: string;
  course_name: string;
  completion_date: string;
  status: string;
  pdf_url: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

/** `YYYY-MM-DD HH:MM:SS` in the UTC session time zone (see knex.ts) → Date. */
const parseTimestamp = (value: string | Date | null, fallback: Date): Date => {
  if (value === null) {
    return fallback;
  }
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const toRow = (certificate: Certificate): CertificateRow => ({
  id: certificate.id,
  student_id: certificate.studentId,
  student_name: certificate.studentName.value,
  course_name: certificate.courseName.value,
  completion_date: certificate.completionDate.value,
  status: certificate.status,
  pdf_url: certificate.pdfUrl,
  attempts: certificate.attempts,
  last_error: certificate.lastError,
  created_at: certificate.createdAt,
  updated_at: certificate.updatedAt,
});

const toEntity = (row: CertificateRow): Certificate => {
  const createdAt = parseTimestamp(row.created_at, new Date(0));
  const result = Certificate.restore({
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    courseName: row.course_name,
    completionDate: row.completion_date,
    status: row.status,
    pdfUrl: row.pdf_url,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt,
    updatedAt: parseTimestamp(row.updated_at, createdAt),
  });
  if (!result.success) {
    throw new Error(`Corrupted certificate row ${row.id}: ${result.error.message}`);
  }
  return result.data;
};

/** MySQL 8 adapter of the CertificateRepository port (knex + mysql2). */
export class MySqlCertificateRepository implements CertificateRepository {
  constructor(private readonly db: Knex) {}

  /** `INSERT … ON DUPLICATE KEY UPDATE`: one round-trip, safe to call for new and existing rows. */
  async save(certificate: Certificate): Promise<void> {
    await this.db<CertificateRow>(CERTIFICATES_TABLE)
      .insert(toRow(certificate))
      .onConflict('id')
      .merge(['status', 'pdf_url', 'attempts', 'last_error', 'updated_at']);
  }

  async findById(id: string): Promise<Certificate | null> {
    const row = await this.db<CertificateRow>(CERTIFICATES_TABLE).where({ id }).first();
    return row === undefined ? null : toEntity(row);
  }

  async findByStatus(status: CertificateStatus, limit = DEFAULT_LIMIT): Promise<Certificate[]> {
    const rows = await this.db<CertificateRow>(CERTIFICATES_TABLE)
      .where({ status })
      .orderBy([{ column: 'created_at' }, { column: 'id' }])
      .limit(limit);
    return rows.map(toEntity);
  }

  async updateStatus(
    id: string,
    status: CertificateStatus,
    pdfUrl?: string,
    error?: string,
  ): Promise<void> {
    await this.db<CertificateRow>(CERTIFICATES_TABLE)
      .where({ id })
      .update({
        status,
        updated_at: new Date(),
        ...(pdfUrl === undefined ? {} : { pdf_url: pdfUrl }),
        ...(error === undefined ? {} : { last_error: error }),
      });
  }

  async countByStatus(): Promise<Record<CertificateStatus, number>> {
    const rows: { status: string; total: number | string }[] = await this.db(CERTIFICATES_TABLE)
      .select('status')
      .count({ total: '*' })
      .groupBy('status');
    const counts = emptyStatusCounts();
    for (const row of rows) {
      if (isCertificateStatus(row.status)) {
        counts[row.status] = Number(row.total);
      }
    }
    return counts;
  }
}
