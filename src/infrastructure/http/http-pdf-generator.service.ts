import { z } from 'zod';
import { PdfGenerationError } from '@application/errors/pdf-generation.error';
import type {
  PdfGenerationData,
  PdfGeneratorService,
} from '@application/interfaces/pdf-generator.service';
import { fail, ok } from '@domain/shared/result';
import type { Result } from '@domain/shared/result';

export type HttpPdfGeneratorOptions = {
  readonly baseUrl: string;
  /** Request deadline; aborts the socket (the circuit breaker uses the same value). */
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
};

const responseSchema = z.object({ pdfUrl: z.string().min(1) });

/** Errors thrown by fetch/undici are duck-typed: `instanceof` is unreliable across realms. */
const isTimeout = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error.name === 'TimeoutError' || error.name === 'AbortError');

const causeOf = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    const { cause } = error;
    if (typeof cause === 'object' && cause !== null && 'code' in cause) {
      return String(cause.code);
    }
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * HTTP client of the external PDF API: `POST {baseUrl}/api/generate-pdf`.
 * The certificate id is sent as `Idempotency-Key`, so a retried request whose first response
 * was lost does not produce a second document.
 */
export class HttpPdfGeneratorService implements PdfGeneratorService {
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: HttpPdfGeneratorOptions) {
    const base = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = `${base}/api/generate-pdf`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(data: PdfGenerationData): Promise<Result<string, PdfGenerationError>> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': data.certificateId },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error: unknown) {
      if (isTimeout(error)) {
        return fail(
          new PdfGenerationError(
            'timeout',
            `PDF API did not answer within ${this.options.timeoutMs} ms`,
            null,
            { cause: error },
          ),
        );
      }
      return fail(
        new PdfGenerationError('network', `PDF API unreachable (${causeOf(error)})`, null, {
          cause: error,
        }),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      return fail(this.httpFailure(response.status, body));
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      return fail(
        new PdfGenerationError(
          'invalid_response',
          'PDF API answered without a pdfUrl',
          response.status,
        ),
      );
    }
    return ok(parsed.data.pdfUrl);
  }

  /** Liveness of the PDF API for /health (not part of the port: an adapter detail). */
  async ping(timeoutMs = 2000): Promise<void> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const response = await this.fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(`PDF API health check answered ${response.status}`);
    }
  }

  private httpFailure(status: number, body: unknown): PdfGenerationError {
    const detail =
      typeof body === 'object' && body !== null && 'error' in body ? `: ${String(body.error)}` : '';
    if (status === 408 || status === 429) {
      return new PdfGenerationError(
        'rate_limited',
        `PDF API answered HTTP ${status}${detail}`,
        status,
      );
    }
    if (status >= 500) {
      return new PdfGenerationError(
        'server_error',
        `PDF API answered HTTP ${status}${detail}`,
        status,
      );
    }
    return new PdfGenerationError(
      'rejected',
      `PDF API rejected the request with HTTP ${status}${detail}`,
      status,
    );
  }
}
