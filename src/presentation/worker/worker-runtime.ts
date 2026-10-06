import type { Express } from 'express';
import type { WorkerContainer } from '@infrastructure/config/container';
import { HealthController } from '@presentation/http/controllers/health.controller';
import { CertificateWorker } from './certificate-worker';
import { DlqAlarmScheduler } from './dlq-alarm.scheduler';
import { createWorkerHttpApp } from './worker-http';
import { WorkerMetrics } from './worker-metrics';

export type WorkerRuntime = {
  readonly worker: CertificateWorker;
  readonly scheduler: DlqAlarmScheduler;
  readonly metrics: WorkerMetrics;
  readonly app: Express;
  /** Stops consuming, waits for in-flight messages, stops the alarm evaluations. */
  readonly stop: () => Promise<void>;
};

/** Starts consuming `certificate.generate` and evaluating the DLQ alarm. */
export const startWorkerRuntime = async (container: WorkerContainer): Promise<WorkerRuntime> => {
  const metrics = new WorkerMetrics();
  const worker = new CertificateWorker(
    container.broker,
    container.generateCertificate,
    metrics,
    container.logger,
  );
  const scheduler = new DlqAlarmScheduler(
    container.monitorDlqDepth,
    container.config.dlqAlarm.intervalMs,
    container.logger,
  );
  const app = createWorkerHttpApp({
    logger: container.logger,
    healthController: new HealthController(container.checkHealth),
    metrics: () => ({
      messages: metrics.snapshot(),
      inFlight: worker.inFlightCount,
      circuitBreaker: container.pdfGenerator.metrics(),
      dlqAlarm: scheduler.lastEvaluation,
      activeAlarms: container.alarms.activeAlarms(),
      alarmsTriggered: container.alarms.triggered,
    }),
  });

  await worker.start();
  scheduler.start();

  return {
    worker,
    scheduler,
    metrics,
    app,
    stop: async () => {
      await worker.stop();
      await scheduler.stop();
    },
  };
};
