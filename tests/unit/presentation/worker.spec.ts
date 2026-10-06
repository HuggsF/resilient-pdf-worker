import request from 'supertest';
import type { DlqAlarmOutput } from '@application/dtos/dlq-alarm.dto';
import type { GenerateCertificateOutcome } from '@application/dtos/generate-certificate.dto';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { GenerateCertificateUseCase } from '@application/use-cases/generate-certificate.use-case';
import type { MonitorDlqDepthUseCase } from '@application/use-cases/monitor-dlq-depth.use-case';
import { fail, ok } from '@domain/shared/result';
import { HealthController } from '@presentation/http/controllers/health.controller';
import { CertificateWorker } from '@presentation/worker/certificate-worker';
import { DlqAlarmScheduler } from '@presentation/worker/dlq-alarm.scheduler';
import { createWorkerHttpApp } from '@presentation/worker/worker-http';
import { WorkerMetrics } from '@presentation/worker/worker-metrics';
import { FakeMessageBroker, createLoggerMock, jobMessage } from '../../support/fakes';

type Execute = GenerateCertificateUseCase['execute'];
type MonitorExecute = MonitorDlqDepthUseCase['execute'];

const completed: GenerateCertificateOutcome = {
  kind: 'completed',
  certificateId: 'a',
  pdfUrl: 'https://cdn.example.edu/a.pdf',
  attempts: 1,
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('CertificateWorker', () => {
  it('consumes certificate.generate and records each outcome', async () => {
    const broker = new FakeMessageBroker();
    const metrics = new WorkerMetrics();
    const execute = jest
      .fn<ReturnType<Execute>, Parameters<Execute>>()
      .mockResolvedValueOnce(ok(completed))
      .mockResolvedValueOnce(
        ok({
          kind: 'dead_lettered',
          certificateId: 'b',
          reason: 'max_retries_exceeded',
          error: 'x',
        }),
      )
      .mockResolvedValueOnce(fail(new UnexpectedError('Processing', new Error('down'))));
    const worker = new CertificateWorker(broker, { execute }, metrics, createLoggerMock());

    await worker.start();
    const handler = broker.handlers.get('certificate.generate')!;
    await handler(jobMessage('a'));
    await handler(jobMessage('b'));
    await handler(jobMessage('c'));

    expect(metrics.snapshot()).toEqual({
      processed: 3,
      outcomes: {
        completed: 1,
        duplicate: 0,
        retry_scheduled: 0,
        deferred: 0,
        dead_lettered: 1,
        unexpected: 1,
      },
      deadLetterReasons: { max_retries_exceeded: 1 },
    });
  });

  it('stops consuming and waits for in-flight messages before resolving stop()', async () => {
    const broker = new FakeMessageBroker();
    let release: () => void = () => undefined;
    const execute = jest.fn<ReturnType<Execute>, Parameters<Execute>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(ok(completed));
          };
        }),
    );
    const worker = new CertificateWorker(
      broker,
      { execute },
      new WorkerMetrics(),
      createLoggerMock(),
    );
    await worker.start();
    const handler = broker.handlers.get('certificate.generate')!;

    const inFlight = handler(jobMessage('a'));
    expect(worker.inFlightCount).toBe(1);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await flush();

    expect(broker.stoppedConsuming).toBe(true);
    expect(stopped).toBe(false);
    release();
    await Promise.all([inFlight, stopping]);
    expect(stopped).toBe(true);
    expect(worker.inFlightCount).toBe(0);
  });

  it('hands back (requeues) a message delivered after the stop request', async () => {
    const broker = new FakeMessageBroker();
    const execute = jest.fn<ReturnType<Execute>, Parameters<Execute>>();
    const worker = new CertificateWorker(
      broker,
      { execute },
      new WorkerMetrics(),
      createLoggerMock(),
    );
    await worker.start();
    await worker.stop();

    await broker.handlers.get('certificate.generate')!(jobMessage('late'));

    expect(execute).not.toHaveBeenCalled();
    expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([true]);
  });
});

describe('DlqAlarmScheduler', () => {
  const evaluation: DlqAlarmOutput = { depth: 2, threshold: 0, state: 'ALARM', changed: true };

  it('evaluates immediately, then every interval, without overlapping', async () => {
    const execute = jest
      .fn<ReturnType<MonitorExecute>, Parameters<MonitorExecute>>()
      .mockResolvedValue(ok(evaluation));
    const logger = createLoggerMock();
    const scheduler = new DlqAlarmScheduler({ execute }, 10, logger);

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await scheduler.stop();
    const calls = execute.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(execute.mock.calls).toHaveLength(calls);
    expect(scheduler.lastEvaluation).toEqual(evaluation);
    expect(logger.info).toHaveBeenCalledWith(evaluation, 'DLQ alarm state changed');
  });

  it('logs failed evaluations and keeps going', async () => {
    const execute = jest
      .fn<ReturnType<MonitorExecute>, Parameters<MonitorExecute>>()
      .mockResolvedValue(fail(new UnexpectedError('Evaluating', new Error('down'))));
    const logger = createLoggerMock();
    const scheduler = new DlqAlarmScheduler({ execute }, 5, logger);

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await scheduler.stop();

    expect(logger.warn).toHaveBeenCalled();
    expect(scheduler.lastEvaluation).toBeNull();
  });
});

describe('worker HTTP endpoints', () => {
  it('exposes /health and /metrics', async () => {
    const app = createWorkerHttpApp({
      logger: createLoggerMock(),
      healthController: new HealthController({
        execute: () =>
          Promise.resolve(
            ok({ status: 'ok' as const, uptimeSeconds: 5, checks: { rabbitmq: 'up' as const } }),
          ),
      }),
      metrics: () => ({ inFlight: 0, circuitBreaker: { state: 'closed' } }),
    });

    const health = await request(app).get('/health');
    const metrics = await request(app).get('/metrics');
    const missing = await request(app).get('/nope');

    expect(health.status).toBe(200);
    expect(metrics.body).toEqual({ inFlight: 0, circuitBreaker: { state: 'closed' } });
    expect(missing.status).toBe(404);
  });
});
