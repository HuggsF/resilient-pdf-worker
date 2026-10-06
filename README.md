# 🛡️ resilient-pdf-worker

> A RabbitMQ worker that **never loses a message** when the external PDF API fails — retries with
> exponential backoff, a circuit breaker and a Dead Letter Queue, verified under chaos.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green?logo=node.js)](https://nodejs.org/)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-3-orange?logo=rabbitmq)](https://www.rabbitmq.com/)
[![MySQL](https://img.shields.io/badge/MySQL-8-blue?logo=mysql)](https://www.mysql.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?logo=docker)](https://docs.docker.com/compose/)
[![Tests](https://img.shields.io/badge/tests-285%20passing-brightgreen)](#-tests)
[![Coverage](https://img.shields.io/badge/coverage-97.6%25-brightgreen)](#-tests)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 🎯 The Problem

An e-learning platform generates PDF certificates in a RabbitMQ worker. One day the external PDF
API starts answering **HTTP 500**. What happens to the messages?

| Strategy | Messages lost? | Failing API hammered? | Visible to operations? |
|---|---|---|---|
| `ack` immediately, log the error | ❌ yes | no | ⚠️ only in logs |
| `nack` **with** requeue | no | ❌ yes — infinite hot loop | ❌ no |
| **Retry with backoff + circuit breaker + `nack` without requeue → DLQ** | ✅ **no** | ✅ **no** | ✅ DLQ depth alarm |

## 💡 The Solution

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "15px", "lineColor": "#64748B", "primaryTextColor": "#0F172A", "clusterBkg": "#F8FAFC", "clusterBorder": "#CBD5E1", "titleColor": "#0F172A", "edgeLabelBackground": "#FFFFFF"}, "flowchart": {"curve": "basis", "nodeSpacing": 30, "rankSpacing": 44, "padding": 12, "wrappingWidth": 340}}}%%
flowchart TB
    API(["📨 POST /api/certificates · 202 Accepted"])
    MAIN[["🐇 certificate.generate<br/><i>durable · persistent messages · publisher confirms · DLX = certificate.dlx</i>"]]
    WORKER("⚙️ Worker · GenerateCertificateUseCase<br/><i>prefetch 10 · ack only after MySQL is updated · idempotent</i>")
    CB{{"Circuit breaker · opossum · opens at 50% errors · 30 s reset"}}
    PDF[("🖨️ PDF API (flaky)")]
    DB[("🗄️ MySQL 8 · status = completed")]

    subgraph RETRIES["⏳ Delayed redelivery — TTL queues dead-letter back to certificate.generate"]
        RETRY[["certificate.retry.1s · .4s · .16s<br/><i>exponential backoff · one attempt per retry</i>"]]
        DEFER[["certificate.retry.30s<br/><i>breaker open · no attempt consumed</i>"]]
    end

    subgraph DEAD["☠️ Dead letters"]
        DLQ[["certificate.dlq"]]
        ALARM("🚨 DLQ depth alarm")
        REPROCESS("POST /api/dlq/reprocess<br/><i>republishes to certificate.generate</i>")
    end

    API --> MAIN --> WORKER --> CB
    CB -->|"closed"| PDF
    PDF -->|"✔ 201 · ack"| DB
    PDF -->|"✘ 500 / timeout · retry ≤ 3"| RETRY
    CB -->|"⏸ open · fail fast"| DEFER
    WORKER -->|"✘ retries exhausted · nack(requeue=false)"| DLQ
    DLQ --> ALARM
    DLQ --> REPROCESS

    classDef io fill:#E0F2FE,stroke:#0284C7,stroke-width:1.5px,color:#0C4A6E
    classDef queue fill:#FFEDD5,stroke:#EA580C,stroke-width:1.5px,color:#431407
    classDef core fill:#EDE9FE,stroke:#7C3AED,stroke-width:1.5px,color:#2E1065
    classDef store fill:#DCFCE7,stroke:#16A34A,stroke-width:1.5px,color:#052E16
    classDef error fill:#FEE2E2,stroke:#DC2626,stroke-width:1.5px,color:#450A0A

    class API,REPROCESS io
    class MAIN,RETRY,DEFER queue
    class WORKER,CB core
    class PDF,DB store
    class DLQ,ALARM error

    style RETRIES fill:#FFFBF5,stroke:#FDBA74,color:#431407
    style DEAD fill:#FEF2F2,stroke:#FCA5A5,color:#450A0A

    linkStyle 4 stroke:#16A34A,stroke-width:2px
    linkStyle 5,7 stroke:#DC2626,stroke-width:2px
    linkStyle 6 stroke:#D97706,stroke-width:2px,stroke-dasharray:6 4
```

- **No premature `ack`**: a message is acknowledged only after the certificate status is
  committed in MySQL; publishes use a confirm channel and persistent messages.
- **Retries without blocking the worker**: failed attempts go to TTL queues (1 s → 4 s → 16 s)
  that dead-letter the message back to `certificate.generate` — no `setTimeout` holding a channel.
- **Circuit breaker**: when the API fails ≥ 50% of the calls, opossum opens for 30 s; messages are
  parked for 30 s **without consuming a retry**, so an outage cannot exhaust everybody's attempts.
- **Dead Letter Queue**: after 3 retries the message is `nack`ed without requeue and routed by
  `certificate.dlx` to `certificate.dlq`; an alarm watches the DLQ depth and
  `POST /api/dlq/reprocess` republishes it once the API is back.
- **Idempotent**: a redelivered message for an already completed certificate is acknowledged
  without generating the PDF again.

### Certificate lifecycle

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "15px", "lineColor": "#64748B", "primaryColor": "#E0F2FE", "primaryBorderColor": "#0284C7", "primaryTextColor": "#0C4A6E", "edgeLabelBackground": "#FFFFFF", "transitionLabelColor": "#334155"}}}%%
stateDiagram-v2
    direction LR
    [*] --> pending: POST /api/certificates
    pending --> processing: worker receives the message
    processing --> completed: PDF generated · ack
    processing --> failed: PDF API error · retry scheduled
    failed --> processing: retry after 1 s / 4 s / 16 s
    processing --> pending: breaker open · deferred 30 s
    failed --> dead_letter: 3 retries exhausted · nack → DLQ
    dead_letter --> pending: POST /api/dlq/reprocess
    completed --> [*]

    classDef waiting fill:#FEF3C7,stroke:#D97706,stroke-width:1.5px,color:#451A03
    classDef running fill:#E0F2FE,stroke:#0284C7,stroke-width:1.5px,color:#0C4A6E
    classDef ok fill:#DCFCE7,stroke:#16A34A,stroke-width:1.5px,color:#052E16
    classDef retry fill:#FFEDD5,stroke:#EA580C,stroke-width:1.5px,color:#431407
    classDef ko fill:#FEE2E2,stroke:#DC2626,stroke-width:1.5px,color:#450A0A

    class pending waiting
    class processing running
    class completed ok
    class failed retry
    class dead_letter ko
```

---

## 📊 Verified Under Chaos — `npm run bench:chaos`

Measured against the **real docker-compose stack** (API + worker + RabbitMQ 3 + MySQL 8 + the
flaky PDF API, 20–80 ms latency) on 2026-10-06 — nothing mocked. Each scenario waits until MySQL
and every queue have settled. Raw output: [`benchmarks/chaos-results.md`](benchmarks/chaos-results.md).

| Scenario | PDF API failure rate | Certificates | Completed | Dead-lettered | **Lost** | PDF API calls | Calls / cert. | Duplicate PDFs | Breaker | Time to settle |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| **Flaky API** | 30% | 300 | 298 | 2 | **0** | 423 (125 failed) | 1.41 | 0 | never opened | 24.2 s |
| **DLQ recovery** | 0% | 2 | 2 | 0 | **0** | 2 | 1.00 | 0 | — | 0.7 s |
| **Degraded API** | 70% for 180 s | 300 | 300 (78 during the incident) | 0 | **0** | 487 (187 failed) | 1.62 | 0 | opened 6× | 213.7 s |
| **Outage** | 100% for 45 s | 100 | 100 (0 during the outage) | 0 | **0** | 146 (46 failed) | 1.46 | 0 | opened 2× | 91.3 s |

**What the numbers show**

- **Zero messages lost, zero duplicate PDFs** across 702 certificates and four failure modes.
- **Retries absorb transient errors**: at 30% failures 298/300 certificates completed on their own.
  The 2 that failed all 4 attempts match the theory (0.3⁴ × 300 ≈ 2.4); both were recovered from
  the DLQ in under a second once the API was healthy.
- **The breaker shields a failing API**: during the 45 s outage only **46** failing calls reached
  the API for 100 messages — without a breaker every message would try 4 times (**400 calls**).
  Everything completed **46 s after the API came back**.
- **Degraded ≠ dead letter**: at 70% failures the breaker kept opening (6×), so throughput dropped
  to 78 certificates in 3 minutes — but messages were *parked*, not dead-lettered: 0 reached the
  DLQ and all 300 completed **34 s after recovery**. This is the trade-off of a 50% threshold:
  the API is protected, latency grows.

> [`benchmarks/BENCHMARK_REPORT.md`](benchmarks/BENCHMARK_REPORT.md) (`npm run bench`) holds
> in-process micro-benchmarks run with in-memory adapters (use-case overhead, breaker fail-fast,
> UUID generation); they are not end-to-end numbers.

---

## 🏗️ Architecture

**Clean Architecture + DDD + TypeScript (strict)** — the API (producer) and the worker (consumer)
are separate processes sharing the same core.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "15px", "lineColor": "#64748B", "primaryTextColor": "#0F172A", "clusterBkg": "#F8FAFC", "clusterBorder": "#CBD5E1", "titleColor": "#0F172A", "edgeLabelBackground": "#FFFFFF"}, "flowchart": {"curve": "basis", "nodeSpacing": 30, "rankSpacing": 60, "padding": 14, "wrappingWidth": 260}}}%%
flowchart LR
    subgraph IN["🚪 Presentation · two processes"]
        direction TB
        HTTP("API process · Express 5<br/><i>enqueue · status · stats · DLQ reprocess · /health</i>")
        WRK("Worker process<br/><i>consumer · DLQ alarm scheduler · graceful shutdown</i>")
    end

    subgraph APP["⚙️ Application · use cases"]
        direction TB
        UC1("EnqueueCertificate")
        UC2("GenerateCertificate")
        UC3("ReprocessDLQ · MonitorDlqDepth")
        UC4("GetCertificateStatus / Stats · CheckHealth")
    end

    subgraph CORE["💎 Domain · zero dependencies"]
        direction TB
        D1["Certificate · status transitions"]
        D2["StudentName · CourseName · CompletionDate · CertificateStatus"]
        D3["RetryStrategy · 1 s → 4 s → 16 s"]
    end

    subgraph PORTS["🔌 Ports · interfaces owned by the core"]
        direction TB
        P1["CertificateRepository"]
        P2["MessageBroker"]
        P3["PdfGeneratorService"]
        P4["AlarmService"]
    end

    subgraph OUT["🔧 Infrastructure · driven adapters"]
        direction TB
        A1("MySqlCertificateRepository<br/><i>knex · mysql2</i>")
        A2("RabbitMqMessageBroker<br/><i>amqplib · confirm channel · TTL retry queues</i>")
        A3("CircuitBreakerPdfGenerator<br/><i>opossum around HttpPdfGeneratorService</i>")
        A4("LogAlarmService<br/><i>CloudWatch-style alarm log</i>")
    end

    HTTP --> UC1
    HTTP --> UC3
    HTTP --> UC4
    WRK --> UC2
    WRK --> UC3
    APP ==>|uses| CORE
    APP -->|depends on| PORTS
    P1 -.-|implemented by| A1
    P2 -.- A2
    P3 -.- A3
    P4 -.- A4

    classDef pres fill:#E0F2FE,stroke:#0284C7,stroke-width:1.5px,color:#0C4A6E
    classDef app fill:#DCFCE7,stroke:#16A34A,stroke-width:1.5px,color:#052E16
    classDef dom fill:#EDE9FE,stroke:#7C3AED,stroke-width:1.5px,color:#2E1065
    classDef port fill:#FFFFFF,stroke:#7C3AED,stroke-width:1.5px,stroke-dasharray:4 3,color:#2E1065
    classDef infra fill:#FEF3C7,stroke:#D97706,stroke-width:1.5px,color:#451A03

    class HTTP,WRK pres
    class UC1,UC2,UC3,UC4 app
    class D1,D2,D3 dom
    class P1,P2,P3,P4 port
    class A1,A2,A3,A4 infra

    style IN fill:#F0F9FF,stroke:#7DD3FC,color:#0C4A6E
    style APP fill:#F0FDF4,stroke:#86EFAC,color:#052E16
    style CORE fill:#F5F3FF,stroke:#C4B5FD,color:#2E1065
    style PORTS fill:#FAF5FF,stroke:#D8B4FE,color:#2E1065
    style OUT fill:#FFFBEB,stroke:#FCD34D,color:#451A03
```

```
src/
├── domain/           # Certificate entity (status transitions), value objects, RetryStrategy, ports
├── application/      # Enqueue, Generate, ReprocessDLQ, MonitorDlqDepth, Status/Stats, Health
├── infrastructure/   # RabbitMQ topology + broker, MySQL repository, circuit-breaker PDF client, config, logging
└── presentation/     # Express API, worker process, CLI (migrate)
chaos/                # Flaky PDF API (failure rate & latency configurable at runtime)
benchmarks/           # chaos-verification.ts (real stack) · run-benchmark.ts (in-process)
```

### Key technical decisions

| Decision | Rationale | ADR |
|---|---|---|
| `nack` without requeue + DLQ | No hot retry loop; failed messages are kept and observable | [ADR-001](docs/adr/001-nack-without-requeue.md) |
| Circuit breaker (opossum) | Stop calling a dead API, fail fast, probe it again after 30 s | [ADR-002](docs/adr/002-circuit-breaker-pattern.md) |
| Exponential backoff via TTL queues | 1 s → 4 s → 16 s without holding the channel or the event loop | [ADR-003](docs/adr/003-retry-with-exponential-backoff.md) |
| Breaker-open messages are deferred, not retried | An outage must not burn every message's retry budget | [ADR-002](docs/adr/002-circuit-breaker-pattern.md) |
| One-shot `migrate` service in Compose | API and worker used to race on `knex_migrations` at boot | — |

---

## 🔌 API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/certificates` | `{ studentId, studentName, courseName, completionDate? }` → `202 { certificateId, status, statusUrl }` |
| `GET` | `/api/certificates/:id` | Status, attempts, last error, PDF URL |
| `GET` | `/api/certificates/stats` | Certificates per status (MySQL) + depth of the work, retry and dead-letter queues |
| `POST` | `/api/dlq/reprocess` | `{ limit? }` → moves DLQ messages back to `certificate.generate` |
| `GET` | `/health` | `503` when MySQL or RabbitMQ is down; `degraded` (still `200`) when only the PDF API is down — the API keeps accepting work |

Flaky PDF API (chaos server, port 4000): `POST /chaos/config { failureRate, minLatencyMs, maxLatencyMs }`,
`GET /chaos/stats`, `POST /chaos/reset`.

---

## 🚀 Quick Start

```bash
docker compose up -d --build        # MySQL, RabbitMQ, flaky PDF API (70% failures), migrate, api, worker
curl localhost:3000/health          # {"status":"ok","checks":{"database":"up","rabbitmq":"up","pdfApi":"up"}}

curl -X POST localhost:3000/api/certificates -H "Content-Type: application/json" \
  -d '{"studentId":"std-1","studentName":"Ada Lovelace","courseName":"Node.js Advanced"}'
curl localhost:3000/api/certificates/stats

npm install && npm run bench:chaos  # the four chaos scenarios above (≈ 6 min)
```

RabbitMQ management UI: <http://localhost:15672> (guest / guest). Configuration: [`.env.example`](.env.example).

---

## 🧪 Tests

```bash
npm test               # 31 suites, 285 tests
npm run test:coverage  # 97.6% statements · 89.1% branches · 94.9% functions · 97.5% lines
```

Unit tests cover the entity transitions, retry strategy, every use case (happy path, API failure,
breaker open, max retries, duplicate delivery), the RabbitMQ/MySQL adapters (with fakes), the
HTTP layer and graceful shutdown. Integration (Testcontainers) and e2e suites are not written yet;
end-to-end behaviour is verified against the real stack by `npm run bench:chaos`.

## 🛠️ Scripts

| Script | Description |
|---|---|
| `npm run dev:api` / `npm run dev:worker` / `npm run dev:chaos` | API, worker and flaky PDF API with hot reload |
| `npm run build` / `npm run start:api` / `npm run start:worker` | Production build and processes |
| `npm run migrate` / `npm run migrate:rollback` | Database migrations |
| `npm run bench:chaos` | End-to-end chaos verification → `benchmarks/chaos-results.md` |
| `npm run bench` | In-process micro-benchmarks → `benchmarks/BENCHMARK_REPORT.md` |
| `npm run chaos:demo` | Short interactive demo against a running stack |
| `npm run lint` / `typecheck` / `format:check` | Quality gates |

## 📚 Tech Stack

| Technology | Role |
|---|---|
| **TypeScript 5.9** (strict) · **Node.js 22+** | Language & runtime |
| **RabbitMQ 3** + **amqplib** | Durable queues, TTL retry queues, DLX/DLQ, publisher confirms |
| **opossum** | Circuit breaker |
| **MySQL 8** + **knex** / mysql2 | Certificate status tracking, migrations |
| **Express 5** | HTTP API + flaky PDF API |
| **zod** · **pino** | Input/config validation · structured logging |
| **Jest** | Unit tests |
| **Docker Compose** | Full local stack, one-shot migrations |

## 📄 License

[MIT](./LICENSE)
