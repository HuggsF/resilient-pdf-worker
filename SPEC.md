# SPEC.md — resilient-pdf-worker

## Overview

| Field | Value |
|---|---|
| **Project** | resilient-pdf-worker |
| **Problem** | Handle external API failures in RabbitMQ workers without losing messages |
| **Interview Question** | Q8 — DOT Digital Group Senior Backend Node.js |
| **Architecture** | Clean Architecture + DDD + TypeScript |

## Problem Statement

A Node.js worker consumes messages from RabbitMQ to generate PDF certificates for an e-learning platform. The external PDF generation API goes down and starts returning HTTP 500 errors. The system must:
1. Not lose any messages (no premature ack)
2. Not overwhelm the failing API (circuit breaker)
3. Route failed messages to a Dead Letter Queue for later reprocessing
4. Alert operations when failures occur

## Solution

Implement nack without requeue + DLQ pattern with retry backoff and circuit breaker. Failed messages go to a Dead Letter Queue, and a CloudWatch-style alarm monitors the DLQ depth.

---

## Domain Model

### Entities

#### Certificate
```typescript
class Certificate {
  readonly id: string
  readonly studentId: string
  readonly studentName: StudentName
  readonly courseName: CourseName
  readonly completionDate: Date
  readonly status: CertificateStatus
  readonly pdfUrl: string | null
  readonly attempts: number
  readonly lastError: string | null

  static create(props: CertificateProps): Result<Certificate, DomainError>
  markAsProcessing(): Certificate
  markAsCompleted(pdfUrl: string): Certificate
  markAsFailed(error: string): Certificate
  canRetry(maxAttempts: number): boolean
}
```

### Value Objects

#### StudentName
- Min 2 chars, max 100

#### CourseName
- Min 2 chars, max 200

#### CertificateStatus
```typescript
type CertificateStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter'
```

### Domain Errors
- `InvalidStudentNameError`
- `InvalidCourseNameError`
- `CertificateAlreadyCompletedError`
- `MaxRetriesExceededError`

### Repository Interfaces

```typescript
interface CertificateRepository {
  save(certificate: Certificate): Promise<void>
  findById(id: string): Promise<Certificate | null>
  findByStatus(status: CertificateStatus): Promise<Certificate[]>
  updateStatus(id: string, status: CertificateStatus, pdfUrl?: string, error?: string): Promise<void>
  countByStatus(): Promise<Record<CertificateStatus, number>>
}
```

---

## Application Layer

### Use Cases

#### GenerateCertificateUseCase
Main use case consumed by the RabbitMQ worker.
- Receives message from queue
- Calls external PDF API
- On success: ack message, update status to completed
- On failure: retry with exponential backoff (3 attempts)
- After max retries: nack without requeue (sends to DLQ)

#### EnqueueCertificateUseCase
Producer: receives HTTP request and enqueues a certificate generation job.

#### ReprocessDLQUseCase
Moves messages from DLQ back to main queue for reprocessing.

#### GetCertificateStatusUseCase
Returns the current status of a certificate by ID.

### Application Interfaces (Ports)

```typescript
interface PdfGeneratorService {
  generate(data: PdfGenerationData): Promise<Result<string, PdfGenerationError>>
}

interface MessageBroker {
  publish(queue: string, message: Buffer): Promise<void>
  consume(queue: string, handler: MessageHandler): Promise<void>
  ack(message: ConsumedMessage): void
  nack(message: ConsumedMessage, requeue: boolean): void
}

interface AlarmService {
  trigger(alarmName: string, metric: number, threshold: number): Promise<void>
}
```

---

## Infrastructure Layer

### RabbitMQ Setup
- **Main Queue**: `certificate.generate`
- **Dead Letter Exchange**: `certificate.dlx`
- **Dead Letter Queue**: `certificate.dlq`
- **Retry Queue**: `certificate.retry` (with TTL for delayed retry)

Queue configuration:
```typescript
// Main queue with DLQ binding
{
  queue: 'certificate.generate',
  options: {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'certificate.dlx',
      'x-dead-letter-routing-key': 'certificate.dlq'
    }
  }
}
```

### Circuit Breaker (opossum)
```typescript
const circuitBreakerOptions = {
  timeout: 10000,        // 10s timeout per request
  errorThresholdPercentage: 50,  // Open after 50% failures
  resetTimeout: 30000,   // Try again after 30s
  volumeThreshold: 5     // Minimum 5 requests before tripping
}
```

### Retry Strategy
- Max retries: 3
- Backoff: exponential (1s, 4s, 16s)
- After max retries: nack without requeue -> DLQ

### Database
- MySQL 8 for certificate status tracking
- Track: id, student info, status, attempts, last error, timestamps

### Fake PDF Server (Chaos Testing)
`chaos/flaky-pdf-server.ts`:
- Express server that simulates the external PDF API
- Configurable failure rate (e.g., 70% chance of HTTP 500)
- Configurable response time (simulate latency)
- Endpoint: `POST /api/generate-pdf`

---

## Presentation Layer

### HTTP API
```
POST   /api/certificates          # Enqueue certificate generation
GET    /api/certificates/:id      # Get certificate status
GET    /api/certificates/stats    # Count by status
POST   /api/dlq/reprocess        # Move DLQ messages back to main queue
GET    /health                    # Health check (RabbitMQ + MySQL + PDF API)
```

---

## Tests

### Unit Tests
- `certificate.entity.spec.ts` — Status transitions, retry logic
- `generate-certificate.use-case.spec.ts` — Happy path, API failure, max retries
- `retry-strategy.spec.ts` — Backoff calculation

### Integration Tests
- `rabbitmq-message-broker.test.ts` — Publish, consume, ack, nack, DLQ routing
- `mysql-certificate-repository.test.ts` — CRUD operations

### E2E Tests
- `certificate-flow.e2e.test.ts` — Full flow: HTTP POST -> Queue -> Worker -> PDF -> Status update

---

## Docker Compose

```yaml
services:
  mysql:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: pdf_worker
    ports: ["3306:3306"]
    healthcheck:
      test: mysqladmin ping -h localhost

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"    # AMQP
      - "15672:15672"  # Management UI
    healthcheck:
      test: rabbitmq-diagnostics -q check_running

  flaky-pdf:
    build:
      context: .
      dockerfile: docker/Dockerfile.chaos
    ports: ["4000:4000"]
    environment:
      FAILURE_RATE: 0.7

  worker:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
    depends_on:
      mysql: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
    environment:
      - RABBITMQ_URL=amqp://rabbitmq:5672
      - DB_HOST=mysql
      - PDF_API_URL=http://flaky-pdf:4000

  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
    command: npm run dev:api
    ports: ["3000:3000"]
    depends_on:
      mysql: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
```

---

## Dependencies

### Production
- amqplib, @types/amqplib, opossum, mysql2, knex, pino, zod, dotenv, uuid, express

### Development
- typescript, tsx, jest, ts-jest, @types/node, @types/express, eslint, prettier, testcontainers, supertest

---

## ADR Documents

1. `docs/adr/001-nack-without-requeue.md` — Why nack without requeue + DLQ instead of nack with requeue
2. `docs/adr/002-circuit-breaker-pattern.md` — Why circuit breaker for external API calls
3. `docs/adr/003-retry-with-exponential-backoff.md` — Why exponential backoff instead of fixed delay
