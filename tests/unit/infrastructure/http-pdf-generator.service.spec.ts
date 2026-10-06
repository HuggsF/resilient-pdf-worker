import { HttpPdfGeneratorService } from '@infrastructure/http/http-pdf-generator.service';

describe('HttpPdfGeneratorService', () => {
  const sampleData = {
    certificateId: 'cert-123',
    studentId: 'student-456',
    studentName: 'Alice Doe',
    courseName: 'TypeScript Masterclass',
    completionDate: '2026-10-06',
  };

  it('generates a PDF successfully and returns the pdfUrl', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ pdfUrl: 'https://cdn.example.com/cert-123.pdf' }),
    });

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 5000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('https://cdn.example.com/cert-123.pdf');
    }
    expect(mockFetch).toHaveBeenCalledWith(
      'http://pdf-api.local/api/generate-pdf',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'cert-123' },
      }),
    );
  });

  it('handles server_error (HTTP 500)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal rendering crash' }),
    });

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 5000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.kind).toBe('server_error');
      expect(result.error.statusCode).toBe(500);
      expect(result.error.message).toContain('Internal rendering crash');
    }
  });

  it('handles rate_limited (HTTP 429 and 408)', async () => {
    const mockFetch429 = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: 'Too Many Requests' }),
    });

    const service429 = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 5000,
      fetch: mockFetch429,
    });

    const result429 = await service429.generate(sampleData);
    expect(result429.success).toBe(false);
    if (!result429.success) {
      expect(result429.error.kind).toBe('rate_limited');
      expect(result429.error.statusCode).toBe(429);
    }

    const mockFetch408 = jest.fn().mockResolvedValue({
      ok: false,
      status: 408,
      json: () => Promise.resolve({ error: 'Request Timeout' }),
    });
    const service408 = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 5000,
      fetch: mockFetch408,
    });
    const result408 = await service408.generate(sampleData);
    expect(result408.success).toBe(false);
    if (!result408.success) {
      expect(result408.error.kind).toBe('rate_limited');
    }
  });

  it('handles client rejection (HTTP 400)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Malformed payload' }),
    });

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 5000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.kind).toBe('rejected');
      expect(result.error.statusCode).toBe(400);
    }
  });

  it('handles invalid response payload (missing pdfUrl)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ wrongKey: 'missing' }),
    });

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 5000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.kind).toBe('invalid_response');
    }
  });

  it('handles timeout/abort errors', async () => {
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'TimeoutError';

    const mockFetch = jest.fn().mockRejectedValue(timeoutError);

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 2000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.kind).toBe('timeout');
      expect(result.error.message).toContain('did not answer within 2000 ms');
    }
  });

  it('handles network unreachable errors', async () => {
    const netError = new Error('fetch failed');
    (netError as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };

    const mockFetch = jest.fn().mockRejectedValue(netError);

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 2000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.kind).toBe('network');
      expect(result.error.message).toContain('ECONNREFUSED');
    }
  });

  it('handles non-JSON error response gracefully', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('Invalid JSON')),
    });

    const service = new HttpPdfGeneratorService({
      baseUrl: 'http://pdf-api.local',
      timeoutMs: 2000,
      fetch: mockFetch,
    });

    const result = await service.generate(sampleData);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.kind).toBe('server_error');
    }
  });

  describe('ping', () => {
    it('succeeds when health check answers HTTP 200', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        body: { cancel: jest.fn().mockResolvedValue(undefined) },
      });

      const service = new HttpPdfGeneratorService({
        baseUrl: 'http://pdf-api.local',
        timeoutMs: 2000,
        fetch: mockFetch,
      });

      await expect(service.ping()).resolves.toBeUndefined();
    });

    it('throws when health check answers non-200', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        body: { cancel: jest.fn().mockResolvedValue(undefined) },
      });

      const service = new HttpPdfGeneratorService({
        baseUrl: 'http://pdf-api.local',
        timeoutMs: 2000,
        fetch: mockFetch,
      });

      await expect(service.ping()).rejects.toThrow('PDF API health check answered 503');
    });
  });
});
