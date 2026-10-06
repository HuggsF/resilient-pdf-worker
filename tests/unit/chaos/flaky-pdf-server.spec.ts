import request from 'supertest';
import {
  createFlakyPdfServer,
  renderCertificatePdf,
  seededRandom,
} from '../../../chaos/flaky-pdf-server';

const payload = {
  certificateId: '0192f1a4-5b6c-7d8e-9f01-23456789abcd',
  studentId: 'student-42',
  studentName: 'José (Zé) da Silva',
  courseName: 'Node.js Advanced',
  completionDate: '2026-02-20',
};

const server = (
  failureRate: number,
  random: () => number = () => 0.5,
): ReturnType<typeof createFlakyPdfServer> =>
  createFlakyPdfServer({
    config: { failureRate, minLatencyMs: 0, maxLatencyMs: 0 },
    publicBaseUrl: 'http://flaky-pdf:4000/',
    random,
  });

describe('flaky PDF server (chaos)', () => {
  it('generates a PDF and returns its URL', async () => {
    const { app, stats } = server(0);

    const response = await request(app).post('/api/generate-pdf').send(payload);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      pdfUrl: `http://flaky-pdf:4000/pdfs/${payload.certificateId}.pdf`,
    });
    expect(stats()).toMatchObject({ requests: 1, successes: 1, uniqueCertificates: 1 });
  });

  it('fails with HTTP 500 at the configured rate', async () => {
    const { app, stats } = server(1);

    const response = await request(app).post('/api/generate-pdf').send(payload);

    expect(response.status).toBe(500);
    expect(stats()).toMatchObject({ requests: 1, injectedFailures: 1, successes: 0 });
  });

  it('counts a second generation of the same certificate as a duplicate', async () => {
    const { app, stats } = server(0);

    await request(app).post('/api/generate-pdf').send(payload);
    await request(app).post('/api/generate-pdf').send(payload);

    expect(stats()).toMatchObject({ successes: 2, uniqueCertificates: 1, duplicateGenerations: 1 });
  });

  it('rejects an invalid payload with 400', async () => {
    const { app, stats } = server(0);

    const response = await request(app).post('/api/generate-pdf').send({ certificateId: 'x' });
    const malformed = await request(app)
      .post('/api/generate-pdf')
      .set('content-type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(stats().invalidRequests).toBe(1);
  });

  it('serves the generated certificate as a real PDF document', async () => {
    const { app } = server(0);
    await request(app).post('/api/generate-pdf').send(payload);

    const response = await request(app)
      .get(`/pdfs/${payload.certificateId}.pdf`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          done(null, Buffer.concat(chunks));
        });
      });
    const missing = await request(app).get('/pdfs/unknown.pdf');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const pdf = (response.body as Buffer).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    // Accents stripped, parentheses escaped for the PDF string syntax.
    expect(pdf).toContain('(Jose \\(Ze\\) da Silva) Tj');
    expect(missing.status).toBe(404);
  });

  it('writes a consistent cross-reference table', () => {
    const pdf = renderCertificatePdf({
      certificateId: 'c',
      studentName: 'Ana',
      courseName: 'Node',
      completionDate: '2026-01-01',
      generatedAt: '2026-01-01T00:00:00.000Z',
    }).toString('latin1');

    const startxref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref).startsWith('xref')).toBe(true);
    const firstObjectOffset = Number(/0000000000 65535 f \n(\d{10})/.exec(pdf)?.[1]);
    expect(pdf.slice(firstObjectOffset).startsWith('1 0 obj')).toBe(true);
  });

  it('can be reconfigured and reset at runtime (the API "comes back")', async () => {
    const { app, config } = server(1);

    const updated = await request(app).post('/chaos/config').send({ failureRate: 0 });
    const invalid = await request(app)
      .post('/chaos/config')
      .send({ minLatencyMs: 500, maxLatencyMs: 10 });
    const unknownField = await request(app).post('/chaos/config').send({ nope: 1 });
    const generated = await request(app).post('/api/generate-pdf').send(payload);
    const reset = await request(app).post('/chaos/reset');

    expect(updated.body).toEqual({ failureRate: 0, minLatencyMs: 0, maxLatencyMs: 0 });
    expect(invalid.status).toBe(400);
    expect(unknownField.status).toBe(400);
    expect(generated.status).toBe(201);
    expect(reset.body).toMatchObject({ requests: 0, successes: 0 });
    expect(config().failureRate).toBe(0);
    expect((await request(app).get('/chaos/config')).body).toEqual(config());
    expect((await request(app).get('/chaos/stats')).body).toMatchObject({ requests: 0 });
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
  });

  it('evicts the oldest document when the store is full', async () => {
    const { app } = createFlakyPdfServer({
      config: { failureRate: 0, minLatencyMs: 0, maxLatencyMs: 0 },
      publicBaseUrl: 'http://localhost:4000',
      maxDocuments: 1,
    });

    await request(app).post('/api/generate-pdf').send(payload);
    await request(app)
      .post('/api/generate-pdf')
      .send({ ...payload, certificateId: 'second' });

    expect((await request(app).get(`/pdfs/${payload.certificateId}.pdf`)).status).toBe(404);
    expect((await request(app).get('/pdfs/second.pdf')).status).toBe(200);
  });

  it('produces a reproducible sequence from a seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const sequence = Array.from({ length: 5 }, () => a());

    expect(Array.from({ length: 5 }, () => b())).toEqual(sequence);
    expect(sequence.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
