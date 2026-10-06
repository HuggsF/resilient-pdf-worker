# 🛡️ resilient-pdf-worker

> Resilient RabbitMQ worker that never loses messages — even when external APIs crash.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)](https://nodejs.org/)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-3.x-orange?logo=rabbitmq)](https://www.rabbitmq.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?logo=docker)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 🎯 The Problem

An e-learning platform generates PDF certificates via a RabbitMQ worker. When the external PDF API goes down (HTTP 500), what happens to the messages?

| Strategy | Messages Lost? | API Hammered? | Observable? |
|---|---|---|---|
| `ack` immediately + log error | ✅ YES | No | ⚠️ Log files only |
| `nack` with requeue | No | ✅ YES (infinite loop) | No |
| Ignore and hope | ✅ YES | ✅ YES | No |
| **nack + DLQ + Circuit Breaker** | ✅ NO | ✅ NO | ✅ YES |

## 💡 The Solution

```
Producer (API)
    │
    ▼
┌────────────────────────────────────────┐
│  certificate.generate (main queue)      │
│       │                                 │
│       ▼                                 │
│  Worker ──► Circuit Breaker ──► PDF API │
│       │         │                       │
│   ✅ ack    ❌ retry (3x backoff)       │
│              │                          │
│        still fails?                     │
│              │                          │
│        nack (no requeue)                │
│              │                          │
│              ▼                          │
│  certificate.dlq (Dead Letter Queue)   │
│              │                          │
│              ▼                          │
│       Alarm triggered                   │
│       Reprocess when API recovers       │
└────────────────────────────────────────┘
```

## 🏗️ Architecture

**Clean Architecture + DDD + TypeScript**

```
src/
├── domain/           # Certificate entity, status transitions, Ports
├── application/      # GenerateCertificate, EnqueueCertificate, ReprocessDLQ use cases
├── infrastructure/   # RabbitMQ adapter, MySQL repo, Circuit Breaker, PDF client
└── presentation/     # Express API, Worker process
```

### Key Technical Decisions

| Decision | Rationale | ADR |
|---|---|---|
| Nack without requeue + DLQ | Prevents infinite retry loops. Messages preserved in DLQ | [ADR-001](docs/adr/001-nack-without-requeue.md) |
| Circuit Breaker (opossum) | Stops calling a dead API. Fails fast, recovers automatically | [ADR-002](docs/adr/002-circuit-breaker-pattern.md) |
| Exponential backoff | 1s → 4s → 16s. Gives the API time to recover | [ADR-003](docs/adr/003-retry-with-exponential-backoff.md) |
| Certificate as Entity | Rich domain model with status transitions and retry logic | — |

## 🧪 Chaos Testing

The project includes a **flaky PDF server** that simulates API failures:

```bash
# Start everything (including flaky server at 70% failure rate)
docker-compose up

# The worker will:
# 1. Process messages from the queue
# 2. Hit the circuit breaker when failures exceed 50%
# 3. Route failed messages to DLQ after 3 retries
# 4. Trigger alarm when DLQ depth > 0

# Watch it in RabbitMQ Management UI:
# http://localhost:15672 (guest/guest)
```

## 🚀 Quick Start

```bash
# 1. Start all services
docker-compose up -d

# 2. Install dependencies
npm install

# 3. Run migrations
npm run migrate

# 4. Start the worker
npm run dev:worker

# 5. Start the API
npm run dev:api

# 6. Enqueue certificates
curl -X POST http://localhost:3000/api/certificates \
  -H "Content-Type: application/json" \
  -d '{"studentId": "abc", "studentName": "John", "courseName": "Node.js Advanced"}'

# 7. Check status
curl http://localhost:3000/api/certificates/stats
```

## 🧪 Tests

```bash
npm test                # Unit tests
npm run test:coverage   # With coverage
npm run test:int        # Integration (requires Docker)
npm run test:e2e        # E2E (requires Docker)
```

## 📚 Tech Stack

| Technology | Role |
|---|---|
| **TypeScript 5.5** | Language |
| **Node.js 20** | Runtime |
| **RabbitMQ** | Message broker |
| **amqplib** | RabbitMQ client |
| **opossum** | Circuit breaker |
| **MySQL 8** | Status tracking |
| **Express** | HTTP API |
| **pino** | Structured logging |
| **Docker Compose** | Local infrastructure |

## 📄 License

MIT
