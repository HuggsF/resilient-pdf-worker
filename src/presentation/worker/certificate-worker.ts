import type { Logger } from '@application/interfaces/logger';
import type { ConsumedMessage, MessageBroker } from '@application/interfaces/message-broker';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import type { GenerateCertificateUseCase } from '@application/use-cases/generate-certificate.use-case';
import type { WorkerMetrics } from './worker-metrics';

/**
 * Consumer of `certificate.generate`: one use-case execution per delivery (up to `prefetch` in
 * parallel). Graceful stop = stop receiving deliveries, then wait for the in-flight ones to be
 * acked/nacked — no message is abandoned half-processed.
 */
export class CertificateWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly broker: Pick<MessageBroker, 'consume' | 'stopConsuming' | 'nack'>,
    private readonly generateCertificate: Pick<GenerateCertificateUseCase, 'execute'>,
    private readonly metrics: WorkerMetrics,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await this.broker.consume(CERTIFICATE_QUEUES.generate, (message) => this.handle(message));
    this.logger.info({ queue: CERTIFICATE_QUEUES.generate }, 'Worker consuming');
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.broker.stopConsuming();
    if (this.inFlight.size > 0) {
      this.logger.info({ inFlight: this.inFlight.size }, 'Waiting for in-flight messages');
    }
    await Promise.allSettled([...this.inFlight]);
  }

  private handle(message: ConsumedMessage): Promise<void> {
    if (this.stopping) {
      // Delivered after the stop request: hand it back untouched.
      this.broker.nack(message, true);
      return Promise.resolve();
    }
    const task: Promise<void> = this.process(message).finally(() => {
      this.inFlight.delete(task);
    });
    this.inFlight.add(task);
    return task;
  }

  private async process(message: ConsumedMessage): Promise<void> {
    const result = await this.generateCertificate.execute({ message });
    if (result.success) {
      this.metrics.record(result.data);
    } else {
      this.metrics.recordUnexpected();
      this.logger.error({ err: result.error }, 'Message processing failed unexpectedly');
    }
  }
}
