/**
 * Flaky PDF API — simulates the external certificate-rendering service for chaos testing.
 *
 * It is deliberately independent from `src/` (it stands for a third-party API):
 *   POST /api/generate-pdf   fails with HTTP 500 at FAILURE_RATE, after a random latency
 *   GET  /pdfs/:id.pdf       serves a real (minimal) PDF of a generated certificate
 *   GET  /chaos/config       current failure rate / latency
 *   POST /chaos/config       change them at runtime, e.g. {"failureRate": 0} = "the API is back"
 *   GET  /chaos/stats        requests, injected failures, successes, duplicate generations
 *   POST /chaos/reset        clears stats and generated documents
 *   GET  /health
 */
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { pino } from 'pino';
import type { Logger } from 'pino';
import { z } from 'zod';

export type ChaosConfig = {
  /** Probability (0..1) that a generation request answers HTTP 500. */
  failureRate: number;
  minLatencyMs: number;
  maxLatencyMs: number;
};

export type ChaosStats = {
  requests: number;
  injectedFailures: number;
  successes: number;
  invalidRequests: number;
  /** Distinct certificates with a generated PDF. */
  uniqueCertificates: number;
  /** Successful requests for a certificate that already had a PDF (idempotency key hit). */
  duplicateGenerations: number;
};

export type FlakyPdfServerOptions = {
  readonly config: ChaosConfig;
  /** Base of the returned `pdfUrl` (how clients reach this server). */
  readonly publicBaseUrl: string;
  /** Injectable randomness: tests and seeded chaos runs are reproducible. */
  readonly random?: () => number;
  readonly logger?: Logger;
  /** Bound on the in-memory document store. */
  readonly maxDocuments?: number;
};

export type FlakyPdfServer = {
  readonly app: Express;
  readonly config: () => Readonly<ChaosConfig>;
  readonly stats: () => Readonly<ChaosStats>;
};

type CertificateDocument = {
  readonly certificateId: string;
  readonly studentName: string;
  readonly courseName: string;
  readonly completionDate: string;
  readonly generatedAt: string;
};

const generateRequestSchema = z.object({
  certificateId: z.string().min(1).max(36),
  studentId: z.string().min(1).max(36).optional(),
  studentName: z.string().min(1).max(200),
  courseName: z.string().min(1).max(300),
  completionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const configSchema = z
  .object({
    failureRate: z.number().min(0).max(1),
    minLatencyMs: z.number().int().min(0).max(60_000),
    maxLatencyMs: z.number().int().min(0).max(60_000),
  })
  .partial()
  .strict();

/** Deterministic PRNG (mulberry32) for reproducible chaos runs. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Standard PDF fonts only cover Latin-1: strip accents, replace the rest, escape delimiters. */
const pdfText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^ -~]/g, '?')
    .replace(/([\\()])/g, '\\$1');

/** A one-page landscape A4 certificate, assembled by hand (no PDF library needed). */
export const renderCertificatePdf = (document: CertificateDocument): Buffer => {
  const lines: [number, number, string][] = [
    [34, 470, 'Certificate of Completion'],
    [16, 400, 'This certifies that'],
    [28, 350, document.studentName],
    [16, 300, 'has successfully completed the course'],
    [22, 255, document.courseName],
    [12, 190, `Completed on ${document.completionDate}`],
    [9, 60, `Certificate ${document.certificateId} - generated ${document.generatedAt}`],
  ];
  const content = lines
    .map(([size, y, text]) => `BT /F1 ${size} Tf 80 ${y} Td (${pdfText(text)}) Tj ET`)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
};

const emptyStats = (): ChaosStats => ({
  requests: 0,
  injectedFailures: 0,
  successes: 0,
  invalidRequests: 0,
  uniqueCertificates: 0,
  duplicateGenerations: 0,
});

export const createFlakyPdfServer = (options: FlakyPdfServerOptions): FlakyPdfServer => {
  const random = options.random ?? Math.random;
  const logger = options.logger ?? pino({ level: 'silent' });
  const maxDocuments = options.maxDocuments ?? 100_000;
  const publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
  let config: ChaosConfig = { ...options.config };
  let stats = emptyStats();
  const documents = new Map<string, CertificateDocument>();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({ status: 'ok' });
  });

  app.post('/api/generate-pdf', async (request: Request, response: Response) => {
    stats.requests += 1;
    const parsed = generateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      stats.invalidRequests += 1;
      response.status(400).json({ error: 'Invalid certificate payload' });
      return;
    }

    const { minLatencyMs, maxLatencyMs, failureRate } = config;
    const latency = minLatencyMs + Math.round(random() * Math.max(0, maxLatencyMs - minLatencyMs));
    await sleep(latency);

    if (random() < failureRate) {
      stats.injectedFailures += 1;
      logger.debug({ certificateId: parsed.data.certificateId, latency }, 'Injected failure');
      response.status(500).json({ error: 'Simulated PDF engine failure' });
      return;
    }

    const { certificateId } = parsed.data;
    if (documents.has(certificateId)) {
      stats.duplicateGenerations += 1;
    } else {
      if (documents.size >= maxDocuments) {
        const oldest = documents.keys().next().value;
        if (oldest !== undefined) documents.delete(oldest);
      }
      documents.set(certificateId, { ...parsed.data, generatedAt: new Date().toISOString() });
      stats.uniqueCertificates = documents.size;
    }
    stats.successes += 1;
    response.status(201).json({ pdfUrl: `${publicBaseUrl}/pdfs/${certificateId}.pdf` });
  });

  app.get('/pdfs/:file', (request: Request<{ file: string }>, response: Response) => {
    const certificateId = request.params.file.replace(/\.pdf$/, '');
    const document = documents.get(certificateId);
    if (document === undefined) {
      response.status(404).json({ error: 'Unknown certificate' });
      return;
    }
    response
      .status(200)
      .type('application/pdf')
      .set('Content-Disposition', `inline; filename="certificate-${certificateId}.pdf"`)
      .send(renderCertificatePdf(document));
  });

  app.get('/chaos/config', (_request: Request, response: Response) => {
    response.json(config);
  });

  app.post('/chaos/config', (request: Request, response: Response) => {
    const parsed = configSchema.safeParse(request.body);
    const next = parsed.success ? { ...config, ...parsed.data } : null;
    if (next === null || next.minLatencyMs > next.maxLatencyMs) {
      response.status(400).json({ error: 'Invalid chaos configuration' });
      return;
    }
    config = next;
    logger.info({ config }, 'Chaos configuration updated');
    response.json(config);
  });

  app.get('/chaos/stats', (_request: Request, response: Response) => {
    response.json(stats);
  });

  app.post('/chaos/reset', (_request: Request, response: Response) => {
    stats = emptyStats();
    documents.clear();
    response.json(stats);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    logger.warn({ err: error }, 'Bad request');
    response.status(400).json({ error: 'Bad request' });
  });

  return { app, config: () => config, stats: () => stats };
};

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.7),
  MIN_LATENCY_MS: z.coerce.number().int().min(0).default(50),
  MAX_LATENCY_MS: z.coerce.number().int().min(0).default(300),
  PUBLIC_BASE_URL: z.string().url().optional(),
  CHAOS_SEED: z.coerce.number().int().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const main = (): void => {
  const env = envSchema.parse(process.env);
  const logger = pino({ name: 'flaky-pdf', level: env.LOG_LEVEL });
  const { app } = createFlakyPdfServer({
    config: {
      failureRate: env.FAILURE_RATE,
      minLatencyMs: env.MIN_LATENCY_MS,
      maxLatencyMs: Math.max(env.MIN_LATENCY_MS, env.MAX_LATENCY_MS),
    },
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
    random: env.CHAOS_SEED === undefined ? Math.random : seededRandom(env.CHAOS_SEED),
    logger,
  });
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, failureRate: env.FAILURE_RATE }, 'Flaky PDF API listening');
  });
  const stop = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
};

if (require.main === module) {
  main();
}
