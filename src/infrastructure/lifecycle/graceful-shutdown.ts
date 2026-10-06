import type { Logger } from '@application/interfaces/logger';

export type ShutdownTask = {
  readonly name: string;
  readonly close: () => Promise<void>;
};

export type ProcessLike = Pick<NodeJS.Process, 'on' | 'off'>;

export type GracefulShutdownOptions = {
  readonly logger: Logger;
  /** Tasks run sequentially, in order (e.g. stop HTTP → drain workers → close DB pool). */
  readonly tasks: readonly ShutdownTask[];
  /** Hard deadline after which the process exits anyway. */
  readonly timeoutMs: number;
  readonly signals?: readonly NodeJS.Signals[];
  /** Also shut down (exit code 1) on unhandledRejection / uncaughtException. Default: true. */
  readonly handleFatalErrors?: boolean;
  readonly exit?: (code: number) => void;
  readonly process?: ProcessLike;
};

export type GracefulShutdown = {
  readonly shutdown: (reason: string, exitCode?: number) => Promise<void>;
  /** Removes the process listeners (tests, hot reload). */
  readonly dispose: () => void;
};

/**
 * Same pattern in every service: on SIGTERM/SIGINT stop taking work, finish what is in
 * flight, release resources, then exit. A second signal or the timeout forces the exit.
 */
export const registerGracefulShutdown = (options: GracefulShutdownOptions): GracefulShutdown => {
  const { logger, tasks, timeoutMs } = options;
  const target = options.process ?? process;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  let shuttingDown: Promise<void> | null = null;

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown !== null) {
      return shuttingDown;
    }
    logger.info({ reason, timeoutMs }, 'Graceful shutdown started');
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    timer.unref();

    shuttingDown = (async (): Promise<void> => {
      let code = exitCode;
      for (const task of tasks) {
        try {
          await task.close();
          logger.info({ task: task.name }, 'Shutdown task completed');
        } catch (error: unknown) {
          code = 1;
          logger.error({ task: task.name, err: error }, 'Shutdown task failed');
        }
      }
      clearTimeout(timer);
      logger.info({ exitCode: code }, 'Graceful shutdown finished');
      exit(code);
    })();
    return shuttingDown;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown !== null) {
      logger.warn({ signal }, 'Second signal received, forcing exit');
      exit(1);
      return;
    }
    void shutdown(signal);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  };
  const onUncaughtException = (error: Error): void => {
    logger.error({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  };

  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const handleFatalErrors = options.handleFatalErrors ?? true;
  for (const signal of signals) {
    target.on(signal, onSignal);
  }
  if (handleFatalErrors) {
    target.on('unhandledRejection', onUnhandledRejection);
    target.on('uncaughtException', onUncaughtException);
  }

  return {
    shutdown,
    dispose: (): void => {
      for (const signal of signals) {
        target.off(signal, onSignal);
      }
      if (handleFatalErrors) {
        target.off('unhandledRejection', onUnhandledRejection);
        target.off('uncaughtException', onUncaughtException);
      }
    },
  };
};
