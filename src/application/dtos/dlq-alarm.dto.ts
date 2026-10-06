export type AlarmState = 'OK' | 'ALARM';

export type DlqAlarmOptions = {
  readonly alarmName: string;
  /** The alarm fires when the DLQ depth is strictly greater than this value. */
  readonly threshold: number;
};

export type DlqAlarmOutput = {
  readonly depth: number;
  readonly threshold: number;
  readonly state: AlarmState;
  /** True when this evaluation moved the alarm to a new state. */
  readonly changed: boolean;
};
