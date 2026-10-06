import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import type { ApiContainer, WorkerContainer } from '@infrastructure/config/container';
import { buildHttpApp, closeServer, listen } from '@presentation/http/server';
import { startWorkerRuntime } from '@presentation/worker/worker-runtime';
import { createLoggerMock } from '../../support/fakes';

describe('Server and Worker Runtime', () => {
  const logger = createLoggerMock();

  describe('HTTP Server', () => {
    it('builds an Express app from ApiContainer', () => {
      const mockApiContainer = {
        logger,
        checkHealth: { execute: jest.fn() },
        enqueueCertificate: { execute: jest.fn() },
        getCertificateStatus: { execute: jest.fn() },
        getCertificateStats: { execute: jest.fn() },
        reprocessDlq: { execute: jest.fn() },
      } as unknown as ApiContainer;

      const app = buildHttpApp(mockApiContainer);
      expect(app).toBeDefined();
    });

    it('listens and closes cleanly on an ephemeral port', async () => {
      const app = express();
      app.get('/test', (_req, res) => res.send('ok'));

      const server: Server = await listen(app, 0);
      expect(server.listening).toBe(true);

      await closeServer(server);
      expect(server.listening).toBe(false);
    });

    it('rejects when listen encounters an error', async () => {
      const mockApp = {
        listen: jest.fn((_port: number, callback: (error?: Error) => void) => {
          callback(new Error('Port already in use'));
          return {} as Server;
        }),
      } as unknown as Express;

      await expect(listen(mockApp, 80)).rejects.toThrow('Port already in use');
    });

    it('rejects when closeServer encounters an error', async () => {
      const mockServer = {
        close: jest.fn((callback: (error?: Error) => void) => {
          callback(new Error('Server close error'));
        }),
        closeIdleConnections: jest.fn(),
      } as unknown as Server;

      await expect(closeServer(mockServer)).rejects.toThrow('Server close error');
    });
  });

  describe('Worker Runtime', () => {
    it('initializes and starts worker runtime, serves metrics, and stops it cleanly', async () => {
      const mockWorkerContainer = {
        logger,
        broker: {
          consume: jest.fn().mockResolvedValue(undefined),
          stopConsuming: jest.fn().mockResolvedValue(undefined),
        },
        generateCertificate: { execute: jest.fn() },
        monitorDlqDepth: {
          execute: jest
            .fn()
            .mockResolvedValue({ success: true, data: { depth: 0, alarmTriggered: false } }),
        },
        checkHealth: { execute: jest.fn() },
        config: {
          dlqAlarm: { intervalMs: 60000 },
        },
        pdfGenerator: {
          metrics: jest.fn().mockReturnValue({ state: 'closed' }),
        },
        alarms: {
          activeAlarms: jest.fn().mockReturnValue([]),
          triggered: 0,
        },
      } as unknown as WorkerContainer;

      const runtime = await startWorkerRuntime(mockWorkerContainer);
      expect(runtime.worker).toBeDefined();
      expect(runtime.scheduler).toBeDefined();
      expect(runtime.metrics).toBeDefined();
      expect(runtime.app).toBeDefined();

      const res = await request(runtime.app).get('/metrics');
      expect(res.status).toBe(200);
      expect((res.body as { circuitBreaker: { state: string } }).circuitBreaker).toEqual({
        state: 'closed',
      });

      await runtime.stop();
      expect(mockWorkerContainer.broker.stopConsuming).toHaveBeenCalled();
    });
  });
});
