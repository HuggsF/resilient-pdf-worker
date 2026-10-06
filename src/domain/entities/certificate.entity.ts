import { CertificateAlreadyCompletedError } from '@domain/errors/certificate-already-completed.error';
import type { DomainError, FieldValidationError } from '@domain/errors/domain.error';
import { InvalidCertificateIdError } from '@domain/errors/invalid-certificate-id.error';
import { InvalidCertificateStateError } from '@domain/errors/invalid-certificate-state.error';
import { InvalidCertificateTransitionError } from '@domain/errors/invalid-certificate-transition.error';
import { InvalidCertificateError } from '@domain/errors/invalid-certificate.error';
import { InvalidCompletionDateError } from '@domain/errors/invalid-completion-date.error';
import { InvalidPdfUrlError } from '@domain/errors/invalid-pdf-url.error';
import { InvalidStudentIdError } from '@domain/errors/invalid-student-id.error';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';
import {
  canTransition,
  parseCertificateStatus,
} from '@domain/value-objects/certificate-status.value-object';
import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';
import { CompletionDate } from '@domain/value-objects/completion-date.value-object';
import { CourseName } from '@domain/value-objects/course-name.value-object';
import { StudentName } from '@domain/value-objects/student-name.value-object';

const MAX_ID_LENGTH = 36;
const MAX_PDF_URL_LENGTH = 500;
const HTTP_URL = /^https?:\/\/\S+$/i;

/** Input of `Certificate.create` — a brand new certificate request. */
export type CertificateProps = {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly courseName: string;
  /** `YYYY-MM-DD` */
  readonly completionDate: string;
  readonly createdAt: Date;
};

/** Every field of a certificate as primitives: what the repository persists and restores. */
export type CertificateSnapshot = {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly courseName: string;
  readonly completionDate: string;
  readonly status: string;
  readonly pdfUrl: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type CertificateState = {
  readonly id: string;
  readonly studentId: string;
  readonly studentName: StudentName;
  readonly courseName: CourseName;
  readonly completionDate: CompletionDate;
  readonly status: CertificateStatus;
  readonly pdfUrl: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

type IdentityFields = Pick<
  CertificateState,
  'id' | 'studentId' | 'studentName' | 'courseName' | 'completionDate'
>;

export type TransitionError = CertificateAlreadyCompletedError | InvalidCertificateTransitionError;

const validateId = <E extends FieldValidationError>(
  raw: string,
  label: string,
  makeError: (value: string, reason: string) => E,
): E | null => {
  const value = raw.trim();
  if (value.length === 0) {
    return makeError(raw, `${label} is required`);
  }
  if (value.length > MAX_ID_LENGTH) {
    return makeError(raw, `${label} must be at most ${MAX_ID_LENGTH} characters`);
  }
  return null;
};

/**
 * A PDF certificate requested for a student who completed a course.
 *
 * Immutable: every state transition returns a **new** instance (or a typed error when the
 * transition breaks a business rule), so a use case can always fall back to the previous
 * version — e.g. when the circuit breaker rejects a call, the attempt never happened.
 */
export class Certificate {
  /** `last_error` is a TEXT column; keep the stored message bounded and readable. */
  static readonly MAX_ERROR_LENGTH = 1000;

  readonly id: string;
  readonly studentId: string;
  readonly studentName: StudentName;
  readonly courseName: CourseName;
  readonly completionDate: CompletionDate;
  readonly status: CertificateStatus;
  readonly pdfUrl: string | null;
  /** Number of generation attempts actually sent to the PDF API. */
  readonly attempts: number;
  readonly lastError: string | null;
  private readonly createdAtMs: number;
  private readonly updatedAtMs: number;

  private constructor(state: CertificateState) {
    this.id = state.id;
    this.studentId = state.studentId;
    this.studentName = state.studentName;
    this.courseName = state.courseName;
    this.completionDate = state.completionDate;
    this.status = state.status;
    this.pdfUrl = state.pdfUrl;
    this.attempts = state.attempts;
    this.lastError = state.lastError;
    this.createdAtMs = state.createdAtMs;
    this.updatedAtMs = state.updatedAtMs;
    Object.freeze(this);
  }

  /** A new certificate request: `pending`, no attempts yet. Reports every invalid field at once. */
  static create(props: CertificateProps): Result<Certificate, InvalidCertificateError> {
    const fields = Certificate.validate(props, props.createdAt);
    if (!fields.success) {
      return fields;
    }
    const createdAtMs = props.createdAt.getTime();
    return ok(
      new Certificate({
        ...fields.data,
        status: 'pending',
        pdfUrl: null,
        attempts: 0,
        lastError: null,
        createdAtMs,
        updatedAtMs: createdAtMs,
      }),
    );
  }

  /** Rebuilds a persisted certificate, re-checking every invariant (corrupted rows are rejected). */
  static restore(snapshot: CertificateSnapshot): Result<Certificate, DomainError> {
    // The "not in the future" rule applied when the request was created; it is not re-checked.
    const fields = Certificate.validate(snapshot, null);
    if (!fields.success) {
      return fields;
    }
    const status = parseCertificateStatus(snapshot.status);
    if (!status.success) {
      return status;
    }
    if (!Number.isInteger(snapshot.attempts) || snapshot.attempts < 0) {
      return fail(
        new InvalidCertificateStateError(snapshot.id, 'attempts must be a non-negative integer'),
      );
    }
    if (status.data === 'completed' && snapshot.pdfUrl === null) {
      return fail(
        new InvalidCertificateStateError(snapshot.id, 'a completed certificate needs a PDF URL'),
      );
    }
    return ok(
      new Certificate({
        ...fields.data,
        status: status.data,
        pdfUrl: snapshot.pdfUrl,
        attempts: snapshot.attempts,
        lastError: snapshot.lastError,
        createdAtMs: snapshot.createdAt.getTime(),
        updatedAtMs: snapshot.updatedAt.getTime(),
      }),
    );
  }

  private static validate(
    props: Omit<CertificateProps, 'createdAt'>,
    createdAt: Date | null,
  ): Result<IdentityFields, InvalidCertificateError> {
    const violations: FieldValidationError[] = [];

    const idError = validateId(
      props.id,
      'Certificate id',
      (value, reason) => new InvalidCertificateIdError(value, reason),
    );
    if (idError) violations.push(idError);

    const studentIdError = validateId(
      props.studentId,
      'Student id',
      (value, reason) => new InvalidStudentIdError(value, reason),
    );
    if (studentIdError) violations.push(studentIdError);

    const studentName = StudentName.create(props.studentName);
    if (!studentName.success) violations.push(studentName.error);

    const courseName = CourseName.create(props.courseName);
    if (!courseName.success) violations.push(courseName.error);

    const completionDate = CompletionDate.create(props.completionDate);
    if (!completionDate.success) {
      violations.push(completionDate.error);
    } else if (createdAt !== null && completionDate.data.isAfter(createdAt)) {
      violations.push(
        new InvalidCompletionDateError(
          props.completionDate,
          'Completion date cannot be in the future',
        ),
      );
    }

    if (
      violations.length > 0 ||
      !studentName.success ||
      !courseName.success ||
      !completionDate.success
    ) {
      return fail(new InvalidCertificateError(violations));
    }
    return ok({
      id: props.id.trim(),
      studentId: props.studentId.trim(),
      studentName: studentName.data,
      courseName: courseName.data,
      completionDate: completionDate.data,
    });
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtMs);
  }

  get isCompleted(): boolean {
    return this.status === 'completed';
  }

  /** Starts a new generation attempt (counts it). Allowed from pending, failed or processing. */
  markAsProcessing(at: Date): Result<Certificate, TransitionError> {
    const allowed = this.ensureTransition('processing');
    if (!allowed.success) {
      return allowed;
    }
    return ok(
      this.with({ status: 'processing', attempts: this.attempts + 1, updatedAtMs: at.getTime() }),
    );
  }

  markAsCompleted(
    pdfUrl: string,
    at: Date,
  ): Result<Certificate, TransitionError | InvalidPdfUrlError> {
    const allowed = this.ensureTransition('completed');
    if (!allowed.success) {
      return allowed;
    }
    const url = pdfUrl.trim();
    if (!HTTP_URL.test(url)) {
      return fail(new InvalidPdfUrlError(pdfUrl, 'PDF URL must be an absolute http(s) URL'));
    }
    if (url.length > MAX_PDF_URL_LENGTH) {
      return fail(
        new InvalidPdfUrlError(pdfUrl, `PDF URL must be at most ${MAX_PDF_URL_LENGTH} characters`),
      );
    }
    return ok(this.with({ status: 'completed', pdfUrl: url, updatedAtMs: at.getTime() }));
  }

  /** The current attempt failed; the certificate may be retried while `canRetry()` holds. */
  markAsFailed(error: string, at: Date): Result<Certificate, TransitionError> {
    const allowed = this.ensureTransition('failed');
    if (!allowed.success) {
      return allowed;
    }
    return ok(
      this.with({ status: 'failed', lastError: truncate(error), updatedAtMs: at.getTime() }),
    );
  }

  /** Parked in the Dead Letter Queue. Idempotent for an already dead-lettered certificate. */
  markAsDeadLetter(reason: string, at: Date): Result<Certificate, TransitionError> {
    if (this.status === 'dead_letter') {
      return ok(this);
    }
    const allowed = this.ensureTransition('dead_letter');
    if (!allowed.success) {
      return allowed;
    }
    return ok(
      this.with({ status: 'dead_letter', lastError: truncate(reason), updatedAtMs: at.getTime() }),
    );
  }

  /**
   * Back to `pending` with a fresh retry budget (DLQ reprocessing once the PDF API is back).
   * `lastError` is kept as history until the next attempt.
   */
  requeue(at: Date): Result<Certificate, TransitionError> {
    const allowed = this.ensureTransition('pending');
    if (!allowed.success) {
      return allowed;
    }
    return ok(this.with({ status: 'pending', attempts: 0, updatedAtMs: at.getTime() }));
  }

  /** True while another attempt is allowed: not final and fewer than `maxAttempts` attempts. */
  canRetry(maxAttempts: number): boolean {
    return (
      this.status !== 'completed' && this.status !== 'dead_letter' && this.attempts < maxAttempts
    );
  }

  toSnapshot(): CertificateSnapshot {
    return {
      id: this.id,
      studentId: this.studentId,
      studentName: this.studentName.value,
      courseName: this.courseName.value,
      completionDate: this.completionDate.value,
      status: this.status,
      pdfUrl: this.pdfUrl,
      attempts: this.attempts,
      lastError: this.lastError,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private ensureTransition(to: CertificateStatus): Result<void, TransitionError> {
    if (this.status === 'completed') {
      return fail(new CertificateAlreadyCompletedError(this.id));
    }
    if (!canTransition(this.status, to)) {
      return fail(new InvalidCertificateTransitionError(this.id, this.status, to));
    }
    return ok(undefined);
  }

  private with(changes: Partial<CertificateState>): Certificate {
    return new Certificate({
      id: this.id,
      studentId: this.studentId,
      studentName: this.studentName,
      courseName: this.courseName,
      completionDate: this.completionDate,
      status: this.status,
      pdfUrl: this.pdfUrl,
      attempts: this.attempts,
      lastError: this.lastError,
      createdAtMs: this.createdAtMs,
      updatedAtMs: this.updatedAtMs,
      ...changes,
    });
  }
}

const truncate = (message: string): string => {
  const trimmed = message.trim() === '' ? 'Unknown error' : message.trim();
  return trimmed.length > Certificate.MAX_ERROR_LENGTH
    ? `${trimmed.slice(0, Certificate.MAX_ERROR_LENGTH - 1)}…`
    : trimmed;
};
