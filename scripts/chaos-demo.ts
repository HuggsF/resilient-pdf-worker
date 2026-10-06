import '../src/module-aliases';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig, loadEnvFile } from '@infrastructure/config/env';
import { createLogger } from '@infrastructure/logging/logger';

type StatsResponse = {
  certificates: Record<string, number>;
  queues: Record<string, number>;
  circuitBreaker?: Record<string, unknown>;
};

const STUDENTS = [
  'Marie Curie',
  'Nikola Tesla',
  'Albert Einstein',
  'Rosalind Franklin',
  'Richard Feynman',
  'Katherine Johnson',
  'Carl Sagan',
  'Barbara Liskov',
];

const main = async (): Promise<void> => {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ ...config.log, name: 'chaos-demo' });
  const apiBase = `http://localhost:${config.http.port}`;
  const chaosBase = config.pdfApi.url;

  logger.info('================================================================');
  logger.info('   RESILIENT PDF WORKER — CHAOS & FAULT TOLERANCE DEMO           ');
  logger.info('================================================================');

  // 1. Verify API Health
  try {
    const healthRes = await fetch(`${apiBase}/health`);
    if (!healthRes.ok) {
      throw new Error(`API returned HTTP ${healthRes.status}`);
    }
    logger.info('HTTP API is alive and reachable.');
  } catch (error: unknown) {
    logger.error(
      { err: error },
      `Cannot connect to API at ${apiBase}. Ensure Docker or dev processes are running: 'docker-compose up' or 'npm run dev'`,
    );
    process.exit(1);
  }

  // 2. Set Flaky PDF Failure Rate to 70% to trigger circuit breaker and retries
  try {
    const chaosConfigRes = await fetch(`${chaosBase}/chaos/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failureRate: 0.7, minLatencyMs: 50, maxLatencyMs: 150 }),
    });
    if (chaosConfigRes.ok) {
      logger.info('Flaky PDF API configured: 70% failure rate (injected chaos)');
    }
  } catch {
    logger.warn(
      'Could not contact chaos config endpoint directly (may be running external mock). Continuing...',
    );
  }

  // 3. Enqueue multiple jobs in parallel
  logger.info(`Enqueueing ${STUDENTS.length} certificate generation requests...`);
  const enqueuedIds: string[] = [];

  for (const [index, student] of STUDENTS.entries()) {
    try {
      const res = await fetch(`${apiBase}/api/certificates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          studentId: `std-${index + 100}`,
          studentName: student,
          courseName: 'Distributed Systems & Chaos Engineering',
          completionDate: '2026-10-06',
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { id: string };
        enqueuedIds.push(data.id);
        logger.info(`Enqueued certificate: [${data.id}] for ${student}`);
      } else {
        logger.error(`Failed to enqueue for ${student}: HTTP ${res.status}`);
      }
    } catch (err: unknown) {
      logger.error({ err }, `Error submitting certificate for ${student}`);
    }
    await sleep(200);
  }

  logger.info(`Successfully dispatched ${enqueuedIds.length} requests.`);
  logger.info('Monitoring real-time queue states and circuit breaker for 15 seconds...');

  for (let i = 1; i <= 5; i += 1) {
    await sleep(3000);
    try {
      const statsRes = await fetch(`${apiBase}/api/certificates/stats`);
      if (statsRes.ok) {
        const stats = (await statsRes.json()) as StatsResponse;
        logger.info(
          {
            iteration: `${i}/5`,
            certificateStatuses: stats.certificates,
            queueDepths: stats.queues,
          },
          'Live Cluster Health Snapshot',
        );
      }
    } catch (err: unknown) {
      logger.warn({ err }, 'Could not fetch stats snapshot');
    }
  }

  logger.info('Chaos demonstration completed successfully.');
  logger.info(
    'To inspect individual certificates: curl http://localhost:3000/api/certificates/<id>',
  );
  logger.info('To reprocess DLQ messages: curl -X POST http://localhost:3000/api/dlq/reprocess');
};

main().catch((error: unknown) => {
  process.stderr.write(`Chaos demo failed: ${String(error)}\n`);
  process.exit(1);
});
