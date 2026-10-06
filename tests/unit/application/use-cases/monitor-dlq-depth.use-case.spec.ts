import { UnexpectedError } from '@application/errors/unexpected.error';
import { MonitorDlqDepthUseCase } from '@application/use-cases/monitor-dlq-depth.use-case';
import { FakeAlarmService, FakeMessageBroker, jobMessage } from '../../../support/fakes';

const ALARM = 'certificate-dlq-depth';

type Setup = {
  readonly broker: FakeMessageBroker;
  readonly alarms: FakeAlarmService;
  readonly useCase: MonitorDlqDepthUseCase;
};

const setup = (threshold = 0): Setup => {
  const broker = new FakeMessageBroker();
  const alarms = new FakeAlarmService();
  const useCase = new MonitorDlqDepthUseCase(broker, alarms, { alarmName: ALARM, threshold });
  return { broker, alarms, useCase };
};

describe('MonitorDlqDepthUseCase', () => {
  it('stays OK while the DLQ depth is within the threshold', async () => {
    const { useCase, alarms } = setup();

    const result = await useCase.execute();

    expect(result).toEqual({
      success: true,
      data: { depth: 0, threshold: 0, state: 'OK', changed: false },
    });
    expect(alarms.triggered).toHaveLength(0);
  });

  it('triggers the alarm once when the depth exceeds the threshold, then resolves it', async () => {
    const { useCase, alarms, broker } = setup();
    broker.enqueue('certificate.dlq', jobMessage('a'), jobMessage('b'));

    const first = await useCase.execute();
    const second = await useCase.execute();
    broker.queues.set('certificate.dlq', []);
    const third = await useCase.execute();

    expect(first.success && first.data).toEqual({
      depth: 2,
      threshold: 0,
      state: 'ALARM',
      changed: true,
    });
    expect(second.success && second.data.changed).toBe(false);
    expect(third.success && third.data).toMatchObject({ state: 'OK', changed: true });
    expect(alarms.triggered).toEqual([{ alarmName: ALARM, metric: 2, threshold: 0 }]);
    expect(alarms.resolved).toEqual([{ alarmName: ALARM, metric: 0, threshold: 0 }]);
  });

  it('honours a custom threshold', async () => {
    const { useCase, broker } = setup(5);
    broker.enqueue('certificate.dlq', ...Array.from({ length: 5 }, () => jobMessage()));

    const result = await useCase.execute();

    expect(result.success && result.data.state).toBe('OK');
  });

  it('fails when the DLQ depth cannot be read', async () => {
    const { useCase, broker } = setup();
    broker.countError = new Error('channel closed');

    const result = await useCase.execute();

    expect(!result.success && result.error).toBeInstanceOf(UnexpectedError);
  });
});
