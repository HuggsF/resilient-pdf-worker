export type MessageHeaders = Readonly<Record<string, string | number | boolean>>;

export type PublishOptions = {
  /** Stable identifier (the certificate id) used for tracing and deduplication. */
  readonly messageId?: string;
  readonly headers?: MessageHeaders;
};

/** A delivery the consumer is responsible for: it must be acked or nacked exactly once. */
export type ConsumedMessage = {
  readonly content: Buffer;
  readonly messageId: string | null;
  readonly headers: Readonly<Record<string, unknown>>;
  /** True when the broker already delivered this message before (consumer crash, requeue). */
  readonly redelivered: boolean;
};

export type MessageHandler = (message: ConsumedMessage) => Promise<void>;

/**
 * Port: message broker (implemented with amqplib / RabbitMQ).
 *
 * Contract:
 * - `publish` sends a **persistent** message and resolves only after the broker confirmed it
 *   (publisher confirms) — a resolved publish is durable, a rejected one may not be.
 * - `ack`/`nack` never throw: when the channel is gone the broker redelivers unacked messages
 *   by itself, and settling a message twice is ignored.
 * - `nack(message, false)` hands the message to the queue's dead-letter exchange.
 */
export interface MessageBroker {
  publish(queue: string, message: Buffer, options?: PublishOptions): Promise<void>;
  consume(queue: string, handler: MessageHandler): Promise<void>;
  /** Stops receiving new deliveries; handlers already running are not interrupted. */
  stopConsuming(): Promise<void>;
  ack(message: ConsumedMessage): void;
  nack(message: ConsumedMessage, requeue: boolean): void;
  /** Pulls a single message (basic.get), or `null` when the queue is empty. */
  get(queue: string): Promise<ConsumedMessage | null>;
  /** Messages ready in the queue (not counting unacked deliveries). */
  messageCount(queue: string): Promise<number>;
}
