import request from 'supertest';
import type { CertificateOutput, CertificateStatsOutput } from '@application/dtos/certificate.dto';
import type { HealthOutput } from '@application/dtos/health.dto';
import { CertificateNotFoundError } from '@application/errors/certificate-not-found.error';
import { QueueUnavailableError } from '@application/errors/queue-unavailable.error';
import { UnexpectedError } from '@application/errors/unexpected.error';
import type { CheckHealthUseCase } from '@application/use-cases/check-health.use-case';
import type { EnqueueCertificateUseCase } from '@application/use-cases/enqueue-certificate.use-case';
import type { GetCertificateStatsUseCase } from '@application/use-cases/get-certificate-stats.use-case';
import type { GetCertificateStatusUseCase } from '@application/use-cases/get-certificate-status.use-case';
import type { ReprocessDlqUseCase } from '@application/use-cases/reprocess-dlq.use-case';
import { Certificate } from '@domain/entities/certificate.entity';
import { fail, ok } from '@domain/shared/result';
import { createHttpApp } from '@presentation/http/app';
import { CertificateController } from '@presentation/http/controllers/certificate.controller';
import { DlqController } from '@presentation/http/controllers/dlq.controller';
import { HealthController } from '@presentation/http/controllers/health.controller';
import type { ErrorResponseBody } from '@presentation/http/errors/http-error';
import { createLoggerMock, validProps } from '../../support/fakes';

type Fn<T extends (...args: never[]) => unknown> = jest.Mock<ReturnType<T>, Parameters<T>>;
type EnqueueExecute = EnqueueCertificateUseCase['execute'];
type StatusExecute = GetCertificateStatusUseCase['execute'];
type StatsExecute = GetCertificateStatsUseCase['execute'];
type ReprocessExecute = ReprocessDlqUseCase['execute'];
type HealthExecute = CheckHealthUseCase['execute'];

const ID = '0192f1a4-5b6c-7d8e-9f01-23456789abcd';

const certificate: CertificateOutput = {
  id: ID,
  studentId: 'student-42',
  studentName: 'Ana Souza',
  courseName: 'Node.js Advanced',
  completionDate: '2026-02-20',
  status: 'completed',
  pdfUrl: `https://cdn.example.edu/${ID}.pdf`,
  attempts: 2,
  lastError: 'PDF API answered HTTP 500',
  createdAt: '2026-03-01T10:00:00.000Z',
  updatedAt: '2026-03-01T10:00:05.000Z',
};

const stats: CertificateStatsOutput = {
  total: 3,
  byStatus: { pending: 1, processing: 0, completed: 1, failed: 0, dead_letter: 1 },
  queues: { generate: 1, retry: 0, deadLetter: 1 },
};

const errorOf = (response: { body: unknown }): ErrorResponseBody['error'] =>
  (response.body as ErrorResponseBody).error;

describe('HTTP API', () => {
  let enqueue: Fn<EnqueueExecute>;
  let status: Fn<StatusExecute>;
  let statsExecute: Fn<StatsExecute>;
  let reprocess: Fn<ReprocessExecute>;
  let health: Fn<HealthExecute>;
  let app: ReturnType<typeof createHttpApp>;
  const logger = createLoggerMock();

  beforeEach(() => {
    enqueue = jest
      .fn<ReturnType<EnqueueExecute>, Parameters<EnqueueExecute>>()
      .mockResolvedValue(ok({ certificateId: ID, status: 'pending' }));
    status = jest
      .fn<ReturnType<StatusExecute>, Parameters<StatusExecute>>()
      .mockResolvedValue(ok(certificate));
    statsExecute = jest
      .fn<ReturnType<StatsExecute>, Parameters<StatsExecute>>()
      .mockResolvedValue(ok(stats));
    reprocess = jest
      .fn<ReturnType<ReprocessExecute>, Parameters<ReprocessExecute>>()
      .mockResolvedValue(ok({ moved: 2, discarded: 0, kept: 0, remaining: 0 }));
    health = jest
      .fn<ReturnType<HealthExecute>, Parameters<HealthExecute>>()
      .mockResolvedValue(
        ok({ status: 'ok', uptimeSeconds: 1, checks: { database: 'up', rabbitmq: 'up' } }),
      );
    app = createHttpApp({
      logger,
      certificateController: new CertificateController(
        { execute: enqueue },
        { execute: status },
        { execute: statsExecute },
      ),
      dlqController: new DlqController({ execute: reprocess }),
      healthController: new HealthController({ execute: health }),
    });
  });

  describe('POST /api/certificates', () => {
    const body = {
      studentId: 'student-42',
      studentName: 'Ana Souza',
      courseName: 'Node.js Advanced',
      completionDate: '2026-02-20',
    };

    it('enqueues the certificate and answers 202 with its status URL', async () => {
      const response = await request(app).post('/api/certificates').send(body);

      expect(response.status).toBe(202);
      expect(response.headers.location).toBe(`/api/certificates/${ID}`);
      expect(response.body).toEqual({
        certificateId: ID,
        status: 'pending',
        statusUrl: `/api/certificates/${ID}`,
      });
      expect(enqueue).toHaveBeenCalledWith(body);
    });

    it('rejects a malformed body with 400 and the list of issues', async () => {
      const response = await request(app)
        .post('/api/certificates')
        .send({ studentName: 42, completionDate: '20/02/2026', extra: true });

      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('maps domain validation failures to 400 with one detail per field', async () => {
      const invalid = Certificate.create(validProps({ studentName: 'A', courseName: '' }));
      if (invalid.success) throw new Error('expected an invalid certificate');
      enqueue.mockResolvedValue(fail(invalid.error));

      const response = await request(app).post('/api/certificates').send(body);

      expect(response.status).toBe(400);
      expect(errorOf(response)).toEqual({
        code: 'INVALID_CERTIFICATE',
        message: 'Invalid certificate request',
        details: [
          { path: 'studentName', message: 'Student name must be at least 2 characters' },
          { path: 'courseName', message: 'Course name must be at least 2 characters' },
        ],
      });
    });

    it('answers 503 + Retry-After when RabbitMQ did not confirm the message', async () => {
      enqueue.mockResolvedValue(fail(new QueueUnavailableError(new Error('closed'))));

      const response = await request(app).post('/api/certificates').send(body);

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
      expect(errorOf(response).code).toBe('QUEUE_UNAVAILABLE');
    });

    it('answers 400 for malformed JSON', async () => {
      const response = await request(app)
        .post('/api/certificates')
        .set('content-type', 'application/json')
        .send('{"studentId":');

      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe('MALFORMED_JSON');
    });

    it('answers 413 for an oversized body', async () => {
      const response = await request(app)
        .post('/api/certificates')
        .send({ ...body, courseName: 'x'.repeat(20_000) });

      expect(response.status).toBe(413);
      expect(errorOf(response).code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('GET /api/certificates/:id', () => {
    it('returns the certificate status', async () => {
      const response = await request(app).get(`/api/certificates/${ID}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(certificate);
      expect(status).toHaveBeenCalledWith({ certificateId: ID });
    });

    it('answers 404 for an unknown certificate', async () => {
      status.mockResolvedValue(fail(new CertificateNotFoundError(ID)));

      const response = await request(app).get(`/api/certificates/${ID}`);

      expect(response.status).toBe(404);
      expect(errorOf(response).code).toBe('CERTIFICATE_NOT_FOUND');
    });

    it('answers 400 for an id that is not a UUID', async () => {
      const response = await request(app).get('/api/certificates/not-a-uuid');

      expect(response.status).toBe(400);
      expect(status).not.toHaveBeenCalled();
    });

    it('never leaks internal errors', async () => {
      status.mockResolvedValue(fail(new UnexpectedError('Loading', new Error('ER_ACCESS_DENIED'))));

      const response = await request(app).get(`/api/certificates/${ID}`);

      expect(response.status).toBe(500);
      expect(errorOf(response)).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });
  });

  describe('GET /api/certificates/stats', () => {
    it('returns the counts by status and the queue depths', async () => {
      const response = await request(app).get('/api/certificates/stats');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(stats);
    });

    it('answers 500 when the counts are unavailable', async () => {
      statsExecute.mockResolvedValue(fail(new UnexpectedError('Counting', new Error('down'))));

      const response = await request(app).get('/api/certificates/stats');

      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/dlq/reprocess', () => {
    it('reprocesses with the default limit when no body is sent', async () => {
      const response = await request(app).post('/api/dlq/reprocess');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ moved: 2, discarded: 0, kept: 0, remaining: 0 });
      expect(reprocess).toHaveBeenCalledWith({});
    });

    it('accepts a limit', async () => {
      await request(app).post('/api/dlq/reprocess').send({ limit: 25 });

      expect(reprocess).toHaveBeenCalledWith({ limit: 25 });
    });

    it('rejects an invalid limit', async () => {
      const response = await request(app).post('/api/dlq/reprocess').send({ limit: 0 });

      expect(response.status).toBe(400);
      expect(reprocess).not.toHaveBeenCalled();
    });

    it('answers 500 when reprocessing fails', async () => {
      reprocess.mockResolvedValue(fail(new UnexpectedError('Reprocessing', new Error('down'))));

      const response = await request(app).post('/api/dlq/reprocess');

      expect(response.status).toBe(500);
    });
  });

  describe('GET /health', () => {
    it.each<[HealthOutput['status'], number]>([
      ['ok', 200],
      ['degraded', 200],
      ['down', 503],
    ])('answers %s with HTTP %i', async (state, code) => {
      health.mockResolvedValue(ok({ status: state, uptimeSeconds: 1, checks: {} }));

      const response = await request(app).get('/health');

      expect(response.status).toBe(code);
      expect((response.body as HealthOutput).status).toBe(state);
    });
  });

  it('answers 404 for unknown routes', async () => {
    const response = await request(app).delete('/api/certificates');

    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('turns thrown errors into a generic 500', async () => {
    status.mockRejectedValue(new Error('boom'));

    const response = await request(app).get(`/api/certificates/${ID}`);

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalled();
  });
});
