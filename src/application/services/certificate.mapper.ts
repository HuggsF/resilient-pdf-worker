import type { CertificateOutput } from '@application/dtos/certificate.dto';
import type { PdfGenerationData } from '@application/interfaces/pdf-generator.service';
import type { Certificate } from '@domain/entities/certificate.entity';

export const toCertificateOutput = (certificate: Certificate): CertificateOutput => ({
  id: certificate.id,
  studentId: certificate.studentId,
  studentName: certificate.studentName.value,
  courseName: certificate.courseName.value,
  completionDate: certificate.completionDate.value,
  status: certificate.status,
  pdfUrl: certificate.pdfUrl,
  attempts: certificate.attempts,
  lastError: certificate.lastError,
  createdAt: certificate.createdAt.toISOString(),
  updatedAt: certificate.updatedAt.toISOString(),
});

export const toPdfGenerationData = (certificate: Certificate): PdfGenerationData => ({
  certificateId: certificate.id,
  studentId: certificate.studentId,
  studentName: certificate.studentName.value,
  courseName: certificate.courseName.value,
  completionDate: certificate.completionDate.value,
});
