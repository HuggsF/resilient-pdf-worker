export type LogContext = Record<string, unknown>;

/** Structured logger port (implemented with pino). Context first, message second. */
export interface Logger {
  debug(context: LogContext, message: string): void;
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string): void;
}
