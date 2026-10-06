# ADR-001: Nack Without Requeue + Dead Letter Queue (DLQ) Pattern

## Status
**Accepted**

## Date
2026-10-06

## Context
In our e-learning platform, asynchronous worker processes consume certificate generation jobs from RabbitMQ (`certificate.generate`) and orchestrate rendering with an external PDF generation microservice. 

When the external PDF service experiences unrecoverable errors (e.g., persistent HTTP 500 internal server errors, malformed payloads, non-recoverable database states) or when the maximum retry attempts for a message are exhausted, the worker must decide how to acknowledge or reject the message at the AMQP protocol level:
1. `basic.ack`: Acknowledges the message and removes it from the queue.
2. `basic.nack(requeue=true)`: Rejects the message and requests RabbitMQ to immediately put it back at the head of the queue.
3. `basic.nack(requeue=false)`: Rejects the message without requeueing, routing it to a configured Dead Letter Exchange (DLX).

If a message is rejected with `requeue=true` during an outage, the worker enters a rapid spin loop: the failed message is immediately redelivered, consumed again, fails again, and requeued indefinitely. This creates high CPU utilization on workers, saturates RabbitMQ IOPS, and starves other legitimate messages in the queue (head-of-line blocking). Conversely, prematurely issuing `basic.ack` upon failure causes permanent message loss.

## Decision
We decided to configure RabbitMQ with Dead Letter Exchanges (`x-dead-letter-exchange: certificate.dlx`, routing key `certificate.dlq`) on the primary queue and strictly issue `basic.nack(requeue=false)` for messages that have exhausted their retry budget or are identified as malformed/unrecoverable (poison messages).

Temporary failures within the retry limit are instead routed to dedicated delay queues with per-message or per-queue TTL and dead-letter routing back to the primary queue. Once maximum retries (default: 3) are reached, the worker persists the failure state in MySQL and executes `basic.nack(requeue=false)`.

## Consequences

### Positive
- **Zero Message Loss (At-Least-Once Delivery)**: Failed messages are never discarded; they are preserved immutably in `certificate.dlq`.
- **Elimination of Head-of-Line Blocking**: Erroneous messages do not block healthy messages queued behind them.
- **Controlled System Load**: Workers do not waste CPU cycles in infinite requeue loops.
- **Auditability and Reprocessing**: Operators and automated repair scripts can inspect DLQ contents, diagnose external API issues, and execute deterministic redelivery (`POST /api/dlq/reprocess`).
- **Operational Alerting**: Metrics on DLQ message count trigger alarms (`certificate-dlq-depth`) to alert on-call teams before backlogs degrade SLA.

### Negative / Trade-offs
- **Storage Overhead**: Poison messages consume memory and disk on the RabbitMQ cluster until reprocessed or purged.
- **Topology Complexity**: Requires declaration of exchanges (`certificate.dlx`), bindings, and dead-letter arguments on queues during application startup.
- **Need for Reprocessing Mechanism**: A secondary administrative flow is mandatory to drain and replay DLQ messages once the underlying failure is resolved.

## Implementation References
- Queue topology definition: `src/infrastructure/queue/certificate-topology.ts`
- Message consumption and settlement: `src/application/use-cases/generate-certificate.use-case.ts`
- RabbitMQ broker adapter: `src/infrastructure/queue/rabbitmq-message-broker.ts`
- Reprocessing endpoint: `src/application/use-cases/reprocess-dlq.use-case.ts`
