import { ApplicationError } from './application.error';

/** The message broker did not confirm a publish: the client may retry later. */
export class QueueUnavailableError extends ApplicationError {
  readonly code = 'QUEUE_UNAVAILABLE';

  constructor(cause: unknown) {
    super('The certificate queue is unavailable, please retry later', { cause });
  }
}
