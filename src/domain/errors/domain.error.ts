/** Base class for every business-rule violation raised by the Domain layer. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A Domain error bound to a single field of a record (e.g. a CSV column). */
export abstract class FieldValidationError extends DomainError {
  protected constructor(
    readonly field: string,
    readonly value: string,
    message: string,
  ) {
    super(message);
  }
}
