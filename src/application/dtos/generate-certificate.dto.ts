import type { ConsumedMessage } from '@application/interfaces/message-broker';

export type GenerateCertificateInput = {
  readonly message: ConsumedMessage;
};

export type DeadLetterReason =
  | 'max_retries_exceeded'
  | 'non_retryable_error'
  | 'max_deferrals_exceeded'
  | 'invalid_message'
  | 'certificate_not_found'
  | 'invalid_state';

export type DeferralReason = 'circuit_open' | 'infrastructure_error';

/** What the worker did with the message — every branch settles it exactly once. */
export type GenerateCertificateOutcome =
  /** PDF generated, status persisted, message acked. */
  | {
      readonly kind: 'completed';
      readonly certificateId: string;
      readonly pdfUrl: string;
      readonly attempts: number;
    }
  /** Redelivery of an already completed certificate: acked, the PDF is NOT generated again. */
  | { readonly kind: 'duplicate'; readonly certificateId: string }
  /** Attempt failed: copy published to a delayed-retry queue (confirmed), original acked. */
  | {
      readonly kind: 'retry_scheduled';
      readonly certificateId: string;
      readonly attempts: number;
      readonly retryNumber: number;
      readonly delayMs: number;
      readonly error: string;
    }
  /** Not attempted (circuit open / infrastructure down): parked without spending an attempt. */
  | {
      readonly kind: 'deferred';
      readonly certificateId: string;
      readonly reason: DeferralReason;
      readonly delayMs: number;
      readonly deferrals: number;
    }
  /** `nack(requeue=false)`: RabbitMQ moved the message to the Dead Letter Queue. */
  | {
      readonly kind: 'dead_lettered';
      readonly certificateId: string | null;
      readonly reason: DeadLetterReason;
      readonly error: string;
    };

export type GenerateCertificateOptions = {
  /** How long a message is parked when it could not be attempted (circuit open, DB down). */
  readonly deferDelayMs: number;
  /** Bound on parking: after that many deferrals the message goes to the DLQ. */
  readonly maxDeferrals: number;
};
