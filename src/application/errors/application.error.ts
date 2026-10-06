/** Base class for failures detected by use cases that are not business-rule violations. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
