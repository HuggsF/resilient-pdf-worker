import { EventEmitter } from 'node:events';
import { registerGracefulShutdown } from '@infrastructure/lifecycle/graceful-shutdown';
import type { ProcessLike } from '@infrastructure/lifecycle/graceful-shutdown';
import { createLoggerMock } from '../../support/fakes';

const fakeProcess = (): EventEmitter & ProcessLike =>
  new EventEmitter() as EventEmitter & ProcessLike;

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('registerGracefulShutdown', () => {
  it('runs every task in order on SIGTERM, then exits with 0', async () => {
    const calls: string[] = [];
    const exit = jest.fn();
    const target = fakeProcess();
    const { dispose } = registerGracefulShutdown({
      logger: createLoggerMock(),
      timeoutMs: 1000,
      exit,
      process: target,
      tasks: [
        {
          name: 'http',
          close: async () => {
            calls.push('http');
            await Promise.resolve();
          },
        },
        {
          name: 'db',
          close: async () => {
            calls.push('db');
            await Promise.resolve();
          },
        },
      ],
    });

    target.emit('SIGTERM', 'SIGTERM');
    await flush();

    expect(calls).toEqual(['http', 'db']);
    expect(exit).toHaveBeenCalledWith(0);
    dispose();
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(target.listenerCount('unhandledRejection')).toBe(0);
  });

  it('keeps closing the remaining resources when a task fails and exits with 1', async () => {
    const exit = jest.fn();
    const closeDb = jest.fn().mockResolvedValue(undefined);
    const logger = createLoggerMock();
    const { shutdown } = registerGracefulShutdown({
      logger,
      timeoutMs: 1000,
      exit,
      process: fakeProcess(),
      tasks: [
        { name: 'queue', close: jest.fn().mockRejectedValue(new Error('stuck')) },
        { name: 'db', close: closeDb },
      ],
    });

    await shutdown('test');

    expect(closeDb).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'queue' }),
      'Shutdown task failed',
    );
  });

  it('is idempotent and forces the exit on a second signal', async () => {
    const exit = jest.fn();
    let release: () => void = () => undefined;
    const target = fakeProcess();
    registerGracefulShutdown({
      logger: createLoggerMock(),
      timeoutMs: 1000,
      exit,
      process: target,
      tasks: [
        {
          name: 'slow',
          close: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      ],
    });

    target.emit('SIGINT', 'SIGINT');
    target.emit('SIGINT', 'SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    release();
    await flush();
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('forces the exit when the tasks exceed the timeout', () => {
    jest.useFakeTimers();
    const exit = jest.fn();
    const { shutdown } = registerGracefulShutdown({
      logger: createLoggerMock(),
      timeoutMs: 50,
      exit,
      process: fakeProcess(),
      tasks: [{ name: 'hang', close: () => new Promise<void>(() => undefined) }],
    });

    void shutdown('test');
    jest.advanceTimersByTime(60);

    expect(exit).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });

  it('shuts down with exit code 1 on fatal errors', async () => {
    const exit = jest.fn();
    const target = fakeProcess();
    registerGracefulShutdown({
      logger: createLoggerMock(),
      timeoutMs: 1000,
      exit,
      process: target,
      tasks: [],
    });

    target.emit('uncaughtException', new Error('boom'));
    await flush();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('handles unhandled rejections the same way', async () => {
    const exit = jest.fn();
    const target = fakeProcess();
    registerGracefulShutdown({
      logger: createLoggerMock(),
      timeoutMs: 1000,
      exit,
      process: target,
      tasks: [],
    });

    target.emit('unhandledRejection', 'nope');
    await flush();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('can leave fatal error handling to the caller', () => {
    const target = fakeProcess();

    registerGracefulShutdown({
      logger: createLoggerMock(),
      timeoutMs: 1000,
      exit: jest.fn(),
      process: target,
      tasks: [],
      handleFatalErrors: false,
    });

    expect(target.listenerCount('uncaughtException')).toBe(0);
    expect(target.listenerCount('SIGTERM')).toBe(1);
  });
});
