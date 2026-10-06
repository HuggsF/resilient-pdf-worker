import { PdfGenerationError } from '@application/errors/pdf-generation.error';
import type { PdfGenerationFailureKind } from '@application/errors/pdf-generation.error';
import type { AlarmService } from '@application/interfaces/alarm-service';
import type { Clock } from '@application/interfaces/clock';
import type { IdGenerator } from '@application/interfaces/id-generator';
import type { LogContext, Logger } from '@application/interfaces/logger';
import type {
  ConsumedMessage,
  MessageBroker,
  MessageHandler,
  PublishOptions,
} from '@application/interfaces/message-broker';
import type {
  PdfGenerationData,
  PdfGeneratorService,
} from '@application/interfaces/pdf-generator.service';
import { encodeCertificateJob } from '@application/services/certificate-job.codec';
import { Certificate } from '@domain/entities/certificate.entity';
import type { CertificateProps } from '@domain/entities/certificate.entity';
import type { CertificateRepository } from '@domain/repositories/certificate.repository';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';
import { emptyStatusCounts } from '@domain/value-objects/certificate-status.value-object';
import type { CertificateStatus } from '@domain/value-objects/certificate-status.value-object';

/** Shared, ordered log of side effects — lets tests assert "saved BEFORE acked". */
export class Timeline {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }
}

export class InMemoryCertificateRepository implements CertificateRepository {
  readonly certificates = new Map<string, Certificate>();
  /** Every saved version, in order. */
  readonly saved: Certificate[] = [];
  private failures: Partial<Record<keyof CertificateRepository, Error>> = {};

  constructor(private readonly timeline = new Timeline()) {}

  failOn(operation: keyof CertificateRepository, error = new Error('database down')): void {
    this.failures[operation] = error;
  }

  recover(): void {
    this.failures = {};
  }

  seed(...certificates: Certificate[]): void {
    for (const certificate of certificates) {
      this.certificates.set(certificate.id, certificate);
    }
  }

  async save(certificate: Certificate): Promise<void> {
    await this.maybeFail('save');
    this.certificates.set(certificate.id, certificate);
    this.saved.push(certificate);
    this.timeline.record(`save:${certificate.status}:${certificate.attempts}`);
  }

  async findById(id: string): Promise<Certificate | null> {
    await this.maybeFail('findById');
    return this.certificates.get(id) ?? null;
  }

  async findByStatus(status: CertificateStatus, limit = 100): Promise<Certificate[]> {
    await this.maybeFail('findByStatus');
    return [...this.certificates.values()]
      .filter((certificate) => certificate.status === status)
      .slice(0, limit);
  }

  async updateStatus(id: string, status: CertificateStatus): Promise<void> {
    await this.maybeFail('updateStatus');
    this.timeline.record(`updateStatus:${id}:${status}`);
  }

  async countByStatus(): Promise<Record<CertificateStatus, number>> {
    await this.maybeFail('countByStatus');
    const counts = emptyStatusCounts();
    for (const certificate of this.certificates.values()) {
      counts[certificate.status] += 1;
    }
    return counts;
  }

  private async maybeFail(operation: keyof CertificateRepository): Promise<void> {
    await Promise.resolve();
    const error = this.failures[operation];
    if (error) {
      throw error;
    }
  }
}

export type PublishedMessage = {
  readonly queue: string;
  readonly content: Buffer;
  readonly options: PublishOptions | undefined;
};

/** In-memory broker: queues for `get`/`messageCount`, and a record of every settle call. */
export class FakeMessageBroker implements MessageBroker {
  readonly queues = new Map<string, ConsumedMessage[]>();
  readonly published: PublishedMessage[] = [];
  readonly acked: ConsumedMessage[] = [];
  readonly nacked: { message: ConsumedMessage; requeue: boolean }[] = [];
  readonly handlers = new Map<string, MessageHandler>();
  stoppedConsuming = false;
  publishError: Error | null = null;
  countError: Error | null = null;
  getError: Error | null = null;
  private readonly unacked = new Map<ConsumedMessage, string>();

  constructor(private readonly timeline = new Timeline()) {}

  enqueue(queue: string, ...messages: ConsumedMessage[]): void {
    this.queues.set(queue, [...(this.queues.get(queue) ?? []), ...messages]);
  }

  async publish(queue: string, content: Buffer, options?: PublishOptions): Promise<void> {
    await Promise.resolve();
    if (this.publishError) {
      throw this.publishError;
    }
    this.published.push({ queue, content, options });
    this.timeline.record(`publish:${queue}`);
  }

  async consume(queue: string, handler: MessageHandler): Promise<void> {
    await Promise.resolve();
    this.handlers.set(queue, handler);
  }

  async stopConsuming(): Promise<void> {
    await Promise.resolve();
    this.stoppedConsuming = true;
  }

  ack(message: ConsumedMessage): void {
    this.acked.push(message);
    this.unacked.delete(message);
    this.timeline.record('ack');
  }

  nack(message: ConsumedMessage, requeue: boolean): void {
    this.nacked.push({ message, requeue });
    this.timeline.record(`nack:${String(requeue)}`);
    const queue = this.unacked.get(message);
    this.unacked.delete(message);
    if (requeue && queue !== undefined) {
      this.queues.set(queue, [message, ...(this.queues.get(queue) ?? [])]);
    }
  }

  async get(queue: string): Promise<ConsumedMessage | null> {
    await Promise.resolve();
    if (this.getError) {
      throw this.getError;
    }
    const [next, ...rest] = this.queues.get(queue) ?? [];
    if (next === undefined) {
      return null;
    }
    this.queues.set(queue, rest);
    this.unacked.set(next, queue);
    return next;
  }

  async messageCount(queue: string): Promise<number> {
    await Promise.resolve();
    if (this.countError) {
      throw this.countError;
    }
    return this.queues.get(queue)?.length ?? 0;
  }

  /** Messages delivered by `get` and not settled yet. */
  get unackedCount(): number {
    return this.unacked.size;
  }
}

/** A URL (success) or a `PdfGenerationFailureKind` (typed failure). */
type PdfScriptStep = string;

/** Replays a script of outcomes: a URL → success, a failure kind → typed failure. */
export class ScriptedPdfGenerator implements PdfGeneratorService {
  readonly calls: PdfGenerationData[] = [];
  private readonly script: PdfScriptStep[];

  constructor(...script: PdfScriptStep[]) {
    this.script = script;
  }

  async generate(data: PdfGenerationData): Promise<Result<string, PdfGenerationError>> {
    await Promise.resolve();
    this.calls.push(data);
    const step = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (step === undefined) {
      return ok(`https://cdn.example.edu/certificates/${data.certificateId}.pdf`);
    }
    if (step.startsWith('http')) {
      return ok(step);
    }
    const kind = step as PdfGenerationFailureKind;
    return fail(
      new PdfGenerationError(
        kind,
        `PDF API failure: ${kind}`,
        kind === 'server_error' ? 500 : null,
      ),
    );
  }
}

export class FakeAlarmService implements AlarmService {
  readonly triggered: { alarmName: string; metric: number; threshold: number }[] = [];
  readonly resolved: { alarmName: string; metric: number; threshold: number }[] = [];

  async trigger(alarmName: string, metric: number, threshold: number): Promise<void> {
    await Promise.resolve();
    this.triggered.push({ alarmName, metric, threshold });
  }

  async resolve(alarmName: string, metric: number, threshold: number): Promise<void> {
    await Promise.resolve();
    this.resolved.push({ alarmName, metric, threshold });
  }
}

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-03-01T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private next = 0;

  generate(): string {
    this.next += 1;
    return `0192f1a4-0000-7000-8000-${String(this.next).padStart(12, '0')}`;
  }
}

type LogFn = Logger['info'];
type LogMock = jest.Mock<ReturnType<LogFn>, Parameters<LogFn>>;

export type LoggerMock = { [K in keyof Logger]: LogMock };

const logMock = (): LogMock => jest.fn<ReturnType<LogFn>, [LogContext, string]>();

export const createLoggerMock = (): LoggerMock => ({
  debug: logMock(),
  info: logMock(),
  warn: logMock(),
  error: logMock(),
});

export const CERTIFICATE_ID = '0192f1a4-5b6c-7d8e-9f01-23456789abcd';

export const validProps = (overrides: Partial<CertificateProps> = {}): CertificateProps => ({
  id: CERTIFICATE_ID,
  studentId: 'student-42',
  studentName: 'Ana Souza',
  courseName: 'Node.js Advanced',
  completionDate: '2026-02-20',
  createdAt: new Date('2026-03-01T10:00:00.000Z'),
  ...overrides,
});

/** A valid certificate (throws on invalid props — test helper only). */
export const aCertificate = (overrides: Partial<CertificateProps> = {}): Certificate => {
  const result = Certificate.create(validProps(overrides));
  if (!result.success) {
    throw result.error;
  }
  return result.data;
};

const AT = new Date('2026-03-01T11:00:00.000Z');

/** Applies transitions to reach a given state (throws if a transition is refused). */
export const inState = (
  certificate: Certificate,
  ...steps: ('processing' | 'failed' | 'completed' | 'dead_letter')[]
): Certificate =>
  steps.reduce((current, step) => {
    const next =
      step === 'processing'
        ? current.markAsProcessing(AT)
        : step === 'failed'
          ? current.markAsFailed('HTTP 500', AT)
          : step === 'completed'
            ? current.markAsCompleted(`https://cdn.example.edu/${current.id}.pdf`, AT)
            : current.markAsDeadLetter('gave up', AT);
    if (!next.success) {
      throw next.error;
    }
    return next.data;
  }, certificate);

export const jobMessage = (
  certificateId: string = CERTIFICATE_ID,
  headers: Record<string, unknown> = {},
  redelivered = false,
): ConsumedMessage => ({
  content: encodeCertificateJob({ certificateId }),
  messageId: certificateId,
  headers,
  redelivered,
});

export const rawMessage = (content: string): ConsumedMessage => ({
  content: Buffer.from(content),
  messageId: null,
  headers: {},
  redelivered: false,
});
