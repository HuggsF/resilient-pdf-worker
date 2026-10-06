import { createLogger } from '@infrastructure/logging/logger';

describe('createLogger', () => {
  it('creates a standard JSON logger with default name and given level', () => {
    const logger = createLogger({
      level: 'info',
      pretty: false,
    });

    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('creates a logger with custom name and pretty printing enabled', () => {
    const logger = createLogger({
      name: 'test-logger',
      level: 'debug',
      pretty: true,
    });

    expect(logger).toBeDefined();
    expect(logger.level).toBe('debug');
  });
});
