/**
 * End-to-end chaos verification against the RUNNING docker-compose stack
 * (api + worker + RabbitMQ + MySQL + flaky PDF API). Nothing is mocked.
 *
 *   docker compose up -d --build
 *   npm run bench:chaos
 *
 * Scenarios (each one waits until MySQL and every queue have settled):
 *   1. Flaky API      — 30% of the PDF calls fail: retries (1s/4s/16s) absorb them, a few
 *                       certificates exhaust their retries and are dead-lettered.
 *   2. DLQ recovery   — the API is healed and the DLQ is reprocessed.
 *   3. Degraded API   — 70% failures for a few minutes, then healed: the circuit breaker throttles
 *                       the calls, messages are parked instead of burning retries.
 *   4. Outage         — the API is 100% down, then healed.
 *
 * Writes benchmarks/chaos-results.md and benchmarks/chaos-results.json.
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

type Status = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';

type Stats = {
  readonly total: number;
  readonly byStatus: Readonly<Record<Status, number>>;
  readonly queues: {
    readonly generate: number;
    readonly retry: number;
    readonly deadLetter: number;
  } | null;
};

type ChaosStats = {
  readonly requests: number;
  readonly injectedFailures: number;
  readonly successes: number;
  readonly duplicateGenerations: number;
};

type BreakerEvents = {
  readonly opened: number;
  readonly halfOpen: number;
  readonly closed: number;
};

type ScenarioSpec = {
  readonly name: string;
  /** New certificates enqueued at the start of the scenario (0 = reprocess the DLQ instead). */
  readonly certificates: number;
  readonly failureRate: number;
  /** When set, the API is healed (0% failures) after this long. */
  readonly healAfterMs: number | null;
  readonly reprocessDlq: boolean;
};

type ScenarioResult = {
  readonly name: string;
  readonly failureRate: number;
  readonly incidentMs: number | null;
  readonly certificates: number;
  readonly completed: number;
  readonly completedDuringIncident: number | null;
  readonly deadLetter: number;
  readonly lost: number;
  readonly dlqDepth: number;
  readonly apiRequests: number;
  readonly apiFailures: number;
  readonly duplicatePdfs: number;
  readonly breaker: BreakerEvents;
  readonly durationMs: number;
};

const optionsSchema = z.object({
  certificates: z.coerce.number().int().min(1).max(100_000),
  degradedMs: z.coerce.number().int().min(1000),
  outageCertificates: z.coerce.number().int().min(1).max(10_000),
  outageMs: z.coerce.number().int().min(1000),
  api: z.string().url(),
  chaos: z.string().url(),
  worker: z.string().min(1),
  timeoutMs: z.coerce.number().int().positive(),
});
type Options = z.infer<typeof optionsSchema>;

const ENQUEUE_CONCURRENCY = 25;
const POLL_INTERVAL_MS = 500;

const getJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} answered HTTP ${response.status}`);
  }
  return (await response.json()) as T;
};

const postJson = <T>(url: string, body: unknown): Promise<T> =>
  getJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stats = (options: Options): Promise<Stats> =>
  getJson<Stats>(`${options.api}/api/certificates/stats`);

const chaosStats = (options: Options): Promise<ChaosStats> =>
  getJson<ChaosStats>(`${options.chaos}/chaos/stats`);

const configureChaos = async (options: Options, failureRate: number): Promise<void> => {
  await postJson(`${options.chaos}/chaos/config`, {
    failureRate,
    minLatencyMs: 20,
    maxLatencyMs: 80,
  });
};

/** Circuit-breaker transitions are logged by the worker process; count them in its container logs. */
const breakerEvents = async (options: Options, sinceIso: string): Promise<BreakerEvents> => {
  const { stdout, stderr } = await execFileAsync(
    'docker',
    ['logs', '--since', sinceIso, options.worker],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const logs = `${stdout}\n${stderr}`;
  const count = (marker: string): number => logs.split(marker).length - 1;
  return {
    opened: count('Circuit breaker OPEN'),
    halfOpen: count('Circuit breaker HALF-OPEN'),
    closed: count('Circuit breaker CLOSED'),
  };
};

/** Student names may only contain letters (domain rule), so the index is spelled with A–Z. */
const lettersOf = (index: number): string => {
  let value = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26);
  } while (value > 0);
  return letters;
};

const enqueue = async (options: Options, count: number, tag: string): Promise<void> => {
  let next = 0;
  const workers = Array.from({ length: Math.min(ENQUEUE_CONCURRENCY, count) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      await postJson(`${options.api}/api/certificates`, {
        studentId: `${tag}-${index}`,
        studentName: `Student ${lettersOf(index)}`,
        courseName: 'Distributed Systems and Chaos Engineering',
        completionDate: '2026-10-06',
      });
    }
  });
  await Promise.all(workers);
};

const delta = (after: Stats, before: Stats, status: Status): number =>
  after.byStatus[status] - before.byStatus[status];

/** Settled = nothing pending/processing/failed-awaiting-retry and the work + retry queues are empty. */
const waitUntilSettled = async (options: Options, baseline: Stats): Promise<Stats> => {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    const current = await stats(options);
    const unsettled =
      delta(current, baseline, 'pending') +
      delta(current, baseline, 'processing') +
      delta(current, baseline, 'failed');
    const queuesEmpty =
      current.queues !== null && current.queues.generate === 0 && current.queues.retry === 0;
    if (unsettled <= 0 && queuesEmpty) {
      return current;
    }
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for the stack to settle: ${JSON.stringify(current)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

const runScenario = async (
  options: Options,
  spec: ScenarioSpec,
  tag: string,
): Promise<ScenarioResult> => {
  await configureChaos(options, spec.failureRate);
  const baseline = await stats(options);
  const chaosBefore = await chaosStats(options);
  const sinceIso = new Date().toISOString();
  const startedAt = performance.now();

  let expected = spec.certificates;
  if (spec.reprocessDlq) {
    const reprocessed = await postJson<{ moved: number }>(`${options.api}/api/dlq/reprocess`, {});
    expected = reprocessed.moved;
  } else {
    await enqueue(options, spec.certificates, tag);
  }

  let completedDuringIncident: number | null = null;
  if (spec.healAfterMs !== null) {
    const remaining = spec.healAfterMs - (performance.now() - startedAt);
    await sleep(Math.max(0, remaining));
    completedDuringIncident = delta(await stats(options), baseline, 'completed');
    await configureChaos(options, 0);
  }

  const settled = await waitUntilSettled(options, baseline);
  const durationMs = Math.round(performance.now() - startedAt);
  const chaosAfter = await chaosStats(options);
  const completed = delta(settled, baseline, 'completed');
  // Reprocessed certificates leave `dead_letter` when they complete, so count them by completion.
  const deadLetter = spec.reprocessDlq
    ? settled.byStatus.dead_letter
    : delta(settled, baseline, 'dead_letter');
  return {
    name: spec.name,
    failureRate: spec.failureRate,
    incidentMs: spec.healAfterMs,
    certificates: expected,
    completed,
    completedDuringIncident,
    deadLetter,
    lost: expected - completed - deadLetter,
    dlqDepth: settled.queues?.deadLetter ?? -1,
    apiRequests: chaosAfter.requests - chaosBefore.requests,
    apiFailures: chaosAfter.injectedFailures - chaosBefore.injectedFailures,
    duplicatePdfs: chaosAfter.duplicateGenerations - chaosBefore.duplicateGenerations,
    breaker: await breakerEvents(options, sinceIso),
    durationMs,
  };
};

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const toMarkdown = (results: readonly ScenarioResult[]): string => {
  const rows = results.map((result) =>
    [
      `**${result.name}**`,
      result.incidentMs === null
        ? `${Math.round(result.failureRate * 100)}%`
        : `${Math.round(result.failureRate * 100)}% for ${seconds(result.incidentMs)}`,
      String(result.certificates),
      result.completedDuringIncident === null
        ? String(result.completed)
        : `${result.completed} (${result.completedDuringIncident} during the incident)`,
      String(result.deadLetter),
      `**${result.lost}**`,
      `${result.apiRequests} (${result.apiFailures} failed)`,
      (result.apiRequests / Math.max(1, result.certificates)).toFixed(2),
      String(result.duplicatePdfs),
      `${result.breaker.opened}× open / ${result.breaker.closed}× closed`,
      seconds(result.durationMs),
    ].join(' | '),
  );
  return [
    '# Chaos verification — resilient-pdf-worker',
    '',
    `- **Date:** ${new Date().toISOString()}`,
    `- **Environment:** Node ${process.version} · ${platform()} ${arch()} · ${cpus()[0]?.model.trim() ?? 'unknown CPU'} · docker-compose stack (api + worker + RabbitMQ 3 + MySQL 8 + flaky PDF API, 20–80 ms latency)`,
    '- **Settled** = no certificate pending/processing/failed in MySQL and the work + retry queues are empty.',
    '- **Lost** = certificates − completed − dead-lettered. **Duplicate PDFs** = PDFs generated twice for the same certificate (counted by the PDF API).',
    '',
    '| Scenario | PDF API failure rate | Certificates | Completed | Dead-lettered | Lost | PDF API calls | Calls / certificate | Duplicate PDFs | Circuit breaker | Time to settle |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|',
    ...rows.map((row) => `| ${row} |`),
    '',
    'Reproduce: `docker compose up -d --build && npm run bench:chaos`.',
    '',
  ].join('\n');
};

const program = new Command()
  .name('chaos-verification')
  .option('--certificates <n>', 'certificates per scenario', '300')
  .option('--degraded-ms <ms>', 'duration of the 70% failure incident', '180000')
  .option('--outage-certificates <n>', 'certificates during the outage scenario', '100')
  .option('--outage-ms <ms>', 'duration of the 100% outage', '45000')
  .option('--api <url>', 'API base URL', 'http://localhost:3000')
  .option('--chaos <url>', 'flaky PDF API base URL', 'http://localhost:4000')
  .option('--worker <container>', 'worker container name', 'pdf_worker_consumer')
  .option('--timeout-ms <ms>', 'max wait per scenario', '900000')
  .action(async (raw: unknown) => {
    const options = optionsSchema.parse(raw);
    const write = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    const runTag = `run${Date.now().toString(36)}`;
    const scenarios: ScenarioSpec[] = [
      {
        name: 'Flaky API',
        certificates: options.certificates,
        failureRate: 0.3,
        healAfterMs: null,
        reprocessDlq: false,
      },
      {
        name: 'DLQ recovery',
        certificates: 0,
        failureRate: 0,
        healAfterMs: null,
        reprocessDlq: true,
      },
      {
        name: 'Degraded API',
        certificates: options.certificates,
        failureRate: 0.7,
        healAfterMs: options.degradedMs,
        reprocessDlq: false,
      },
      {
        name: 'Outage',
        certificates: options.outageCertificates,
        failureRate: 1,
        healAfterMs: options.outageMs,
        reprocessDlq: false,
      },
    ];

    await postJson(`${options.chaos}/chaos/reset`, {});
    const results: ScenarioResult[] = [];
    for (const [index, spec] of scenarios.entries()) {
      write(`${index + 1}/${scenarios.length} ${spec.name}…`);
      const result = await runScenario(options, spec, `${runTag}-${index}`);
      write(JSON.stringify(result));
      results.push(result);
    }

    const markdown = toMarkdown(results);
    await writeFile(join(__dirname, 'chaos-results.md'), markdown, 'utf8');
    await writeFile(
      join(__dirname, 'chaos-results.json'),
      JSON.stringify({ measuredAt: new Date().toISOString(), options, results }, null, 2),
      'utf8',
    );
    write(`\n${markdown}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(
    `chaos verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
