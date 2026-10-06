/**
 * Port: operational alarms (CloudWatch-style: a metric crossed a threshold).
 * Implemented as structured log records; a CloudWatch/SNS/Slack adapter would implement the same
 * interface.
 */
export interface AlarmService {
  /** The metric breached the threshold: the alarm enters the ALARM state. */
  trigger(alarmName: string, metric: number, threshold: number): Promise<void>;
  /** The metric is back within the threshold: the alarm returns to OK. */
  resolve(alarmName: string, metric: number, threshold: number): Promise<void>;
}
