import { ApplicationError } from './application.error';

/** A queue message that cannot be decoded (poison message). */
export class InvalidJobMessageError extends ApplicationError {
  readonly code = 'INVALID_JOB_MESSAGE';

  constructor(reason: string) {
    super(`Invalid certificate job message: ${reason}`);
  }
}
