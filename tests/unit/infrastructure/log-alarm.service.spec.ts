import { LogAlarmService } from '@infrastructure/monitoring/log-alarm.service';
import { FixedClock, createLoggerMock } from '../../support/fakes';

describe('LogAlarmService', () => {
  it('logs a CloudWatch-style ALARM record and tracks the active alarm', async () => {
    const logger = createLoggerMock();
    const alarms = new LogAlarmService(logger, new FixedClock());

    await alarms.trigger('certificate-dlq-depth', 3, 0);

    expect(logger.error).toHaveBeenCalledWith(
      {
        alarm: {
          name: 'certificate-dlq-depth',
          state: 'ALARM',
          metric: 3,
          threshold: 0,
          comparison: 'GreaterThanThreshold',
        },
      },
      'ALARM certificate-dlq-depth: 3 > 0',
    );
    expect(alarms.activeAlarms()).toEqual([
      {
        alarmName: 'certificate-dlq-depth',
        metric: 3,
        threshold: 0,
        since: '2026-03-01T12:00:00.000Z',
      },
    ]);
    expect(alarms.triggered).toBe(1);
  });

  it('logs the return to OK and clears the active alarm', async () => {
    const logger = createLoggerMock();
    const alarms = new LogAlarmService(logger, new FixedClock());
    await alarms.trigger('certificate-dlq-depth', 3, 0);

    await alarms.resolve('certificate-dlq-depth', 0, 0);

    expect(logger.info).toHaveBeenCalledWith(
      { alarm: { name: 'certificate-dlq-depth', state: 'OK', metric: 0, threshold: 0 } },
      'OK certificate-dlq-depth: 0 <= 0',
    );
    expect(alarms.activeAlarms()).toEqual([]);
  });
});
