import type { DlqAlarmOutput } from '@application/dtos/dlq-alarm.dto';
import type { Logger } from '@application/interfaces/logger';
import type { MonitorDlqDepthUseCase } from '@application/use-cases/monitor-dlq-depth.use-case';

/**
 * Evaluates the DLQ alarm every `intervalMs` (CloudWatch alarm period). Evaluations never
 * overlap: the next one is scheduled when the previous one finished.
 */
export class DlqAlarmScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private last: DlqAlarmOutput | null = null;

  constructor(
    private readonly monitor: Pick<MonitorDlqDepthUseCase, 'execute'>,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  get lastEvaluation(): DlqAlarmOutput | null {
    return this.last;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.evaluate().finally(() => {
        this.running = null;
        if (!this.stopped) {
          this.schedule(this.intervalMs);
        }
      });
    }, delayMs);
    this.timer.unref();
  }

  private async evaluate(): Promise<void> {
    const result = await this.monitor.execute();
    if (!result.success) {
      this.logger.warn({ err: result.error }, 'DLQ alarm evaluation failed');
      return;
    }
    this.last = result.data;
    if (result.data.changed) {
      this.logger.info({ ...result.data }, 'DLQ alarm state changed');
    }
  }
}
