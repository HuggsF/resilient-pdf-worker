import { z } from 'zod';

/**
 * Shape validation only (types, presence, gross sizes). Business rules — name lengths, real
 * calendar dates, "not in the future" — belong to the Domain value objects.
 */
export const enqueueCertificateBodySchema = z
  .object({
    studentId: z.string().min(1).max(36),
    studentName: z.string().max(500),
    courseName: z.string().max(1000),
    completionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
      .optional(),
  })
  .strict();

export const certificateIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const reprocessDlqBodySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(10_000).optional(),
  })
  .strict();
