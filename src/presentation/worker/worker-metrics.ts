import type { GenerateCertificateOutcome } from '@application/dtos/generate-certificate.dto';

export type OutcomeKind = GenerateCertificateOutcome['kind'];

export type WorkerMetricsSnapshot = {
  readonly processed: number;
  readonly outcomes: Readonly<Record<OutcomeKind | 'unexpected', number>>;
  readonly deadLetterReasons: Readonly<Record<string, number>>;
};

/** In-process counters of what the worker did with each delivery (exposed on GET /metrics). */
export class WorkerMetrics {
  private readonly outcomes: Record<OutcomeKind | 'unexpected', number> = {
    completed: 0,
    duplicate: 0,
    retry_scheduled: 0,
    deferred: 0,
    dead_lettered: 0,
    unexpected: 0,
  };
  private readonly deadLetterReasons: Record<string, number> = {};

  record(outcome: GenerateCertificateOutcome): void {
    this.outcomes[outcome.kind] += 1;
    if (outcome.kind === 'dead_lettered') {
      this.deadLetterReasons[outcome.reason] = (this.deadLetterReasons[outcome.reason] ?? 0) + 1;
    }
  }

  recordUnexpected(): void {
    this.outcomes.unexpected += 1;
  }

  snapshot(): WorkerMetricsSnapshot {
    return {
      processed: Object.values(this.outcomes).reduce((sum, count) => sum + count, 0),
      outcomes: { ...this.outcomes },
      deadLetterReasons: { ...this.deadLetterReasons },
    };
  }
}
