import type { AlarmService } from '@application/interfaces/alarm-service';
import type { Clock } from '@application/interfaces/clock';
import type { Logger } from '@application/interfaces/logger';

export type ActiveAlarm = {
  readonly alarmName: string;
  readonly metric: number;
  readonly threshold: number;
  readonly since: string;
};

/**
 * CloudWatch-style alarm adapter: every state change is a structured log record
 * (`alarm.state = ALARM | OK`) that a log-based metric filter / alert rule can match.
 * Swapping it for SNS, CloudWatch `PutMetricAlarm` or Slack only means another adapter.
 */
export class LogAlarmService implements AlarmService {
  private readonly active = new Map<string, ActiveAlarm>();
  private triggeredCount = 0;

  constructor(
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  trigger(alarmName: string, metric: number, threshold: number): Promise<void> {
    this.triggeredCount += 1;
    this.active.set(alarmName, {
      alarmName,
      metric,
      threshold,
      since: this.clock.now().toISOString(),
    });
    this.logger.error(
      {
        alarm: {
          name: alarmName,
          state: 'ALARM',
          metric,
          threshold,
          comparison: 'GreaterThanThreshold',
        },
      },
      `ALARM ${alarmName}: ${metric} > ${threshold}`,
    );
    return Promise.resolve();
  }

  resolve(alarmName: string, metric: number, threshold: number): Promise<void> {
    this.active.delete(alarmName);
    this.logger.info(
      { alarm: { name: alarmName, state: 'OK', metric, threshold } },
      `OK ${alarmName}: ${metric} <= ${threshold}`,
    );
    return Promise.resolve();
  }

  activeAlarms(): readonly ActiveAlarm[] {
    return [...this.active.values()];
  }

  get triggered(): number {
    return this.triggeredCount;
  }
}
