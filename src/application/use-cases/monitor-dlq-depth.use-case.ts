import type { AlarmState, DlqAlarmOptions, DlqAlarmOutput } from '@application/dtos/dlq-alarm.dto';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { AlarmService } from '@application/interfaces/alarm-service';
import type { MessageBroker } from '@application/interfaces/message-broker';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

/**
 * CloudWatch-style alarm on the DLQ depth, evaluated periodically by the worker. It notifies on
 * state *changes* only (OK → ALARM, ALARM → OK), not on every evaluation.
 */
export class MonitorDlqDepthUseCase {
  private state: AlarmState = 'OK';

  constructor(
    private readonly broker: Pick<MessageBroker, 'messageCount'>,
    private readonly alarmService: AlarmService,
    private readonly options: DlqAlarmOptions,
  ) {}

  async execute(): Promise<Result<DlqAlarmOutput, UnexpectedError>> {
    const { alarmName, threshold } = this.options;
    try {
      const depth = await this.broker.messageCount(CERTIFICATE_QUEUES.deadLetter);
      const next: AlarmState = depth > threshold ? 'ALARM' : 'OK';
      const changed = next !== this.state;
      if (changed && next === 'ALARM') {
        await this.alarmService.trigger(alarmName, depth, threshold);
      } else if (changed) {
        await this.alarmService.resolve(alarmName, depth, threshold);
      }
      this.state = next;
      return ok({ depth, threshold, state: next, changed });
    } catch (error: unknown) {
      return fail(new UnexpectedError('Evaluating the DLQ alarm', error));
    }
  }
}
