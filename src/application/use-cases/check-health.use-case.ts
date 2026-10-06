import type { DependencyStatus, HealthOutput, HealthStatus } from '@application/dtos/health.dto';
import type { Clock } from '@application/interfaces/clock';
import type { HealthIndicator } from '@application/interfaces/health-indicator';
import { ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

/** Checks every dependency in parallel, each bounded by a timeout so /health never hangs. */
export class CheckHealthUseCase {
  private readonly startedAtMs: number;

  constructor(
    private readonly indicators: readonly HealthIndicator[],
    private readonly clock: Clock,
    private readonly timeoutMs = 2000,
  ) {
    this.startedAtMs = clock.now().getTime();
  }

  async execute(): Promise<Result<HealthOutput, never>> {
    const results = await Promise.all(
      this.indicators.map(async (indicator) => ({
        indicator,
        status: await this.probe(indicator),
      })),
    );
    const isDown = ({ status }: { status: DependencyStatus }): boolean => status === 'down';
    const down = results.filter(isDown);
    let status: HealthStatus = 'ok';
    if (down.some(({ indicator }) => indicator.critical !== false)) {
      status = 'down';
    } else if (down.length > 0) {
      status = 'degraded';
    }

    return ok({
      status,
      uptimeSeconds: Math.round((this.clock.now().getTime() - this.startedAtMs) / 1000),
      checks: Object.fromEntries(results.map(({ indicator, status: s }) => [indicator.name, s])),
    });
  }

  private async probe(indicator: HealthIndicator): Promise<DependencyStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${indicator.name} health check timed out`));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([indicator.check(), timeout]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
