import { CheckHealthUseCase } from '@application/use-cases/check-health.use-case';
import type { HealthIndicator } from '@application/interfaces/health-indicator';
import { FixedClock } from '../../../support/fakes';

const up = (name: string, critical?: boolean): HealthIndicator => ({
  name,
  critical,
  check: () => Promise.resolve(),
});
const down = (name: string, critical?: boolean): HealthIndicator => ({
  name,
  critical,
  check: () => Promise.reject(new Error(`${name} unreachable`)),
});

describe('CheckHealthUseCase', () => {
  it('is ok when every dependency answers, and reports the uptime', async () => {
    const clock = new FixedClock();
    const useCase = new CheckHealthUseCase([up('database'), up('rabbitmq')], clock);
    clock.advance(42_400);

    const result = await useCase.execute();

    expect(result).toEqual({
      success: true,
      data: { status: 'ok', uptimeSeconds: 42, checks: { database: 'up', rabbitmq: 'up' } },
    });
  });

  it('is degraded (still serving) when only a non-critical dependency is down', async () => {
    const useCase = new CheckHealthUseCase(
      [up('database'), up('rabbitmq'), down('pdfApi', false)],
      new FixedClock(),
    );

    const result = await useCase.execute();

    expect(result.success && result.data.status).toBe('degraded');
    expect(result.success && result.data.checks.pdfApi).toBe('down');
  });

  it('is down when a critical dependency is down', async () => {
    const useCase = new CheckHealthUseCase(
      [down('database'), down('pdfApi', false)],
      new FixedClock(),
    );

    const result = await useCase.execute();

    expect(result.success && result.data.status).toBe('down');
  });

  it('bounds every probe with a timeout', async () => {
    const hanging: HealthIndicator = {
      name: 'rabbitmq',
      check: () => new Promise(() => undefined),
    };
    const useCase = new CheckHealthUseCase([hanging], new FixedClock(), 20);

    const result = await useCase.execute();

    expect(result.success && result.data.checks).toEqual({ rabbitmq: 'down' });
  });
});
