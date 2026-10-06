export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export type ErrorResponseBody = {
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
};
