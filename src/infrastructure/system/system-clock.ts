import type { Clock } from '@application/interfaces/clock';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
