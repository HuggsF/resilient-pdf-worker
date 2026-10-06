# ADR-003: Retry with Exponential Backoff Strategy via AMQP Dead-Letter Delays

## Status
**Accepted**

## Date
2026-10-06

## Context
Transient failures (such as intermittent network hiccups, brief load spikes, and temporary container restarts) are inevitable in distributed microservice architectures. When an external call fails transiently, retrying immediately with zero delay or with fixed intervals has severe shortcomings:
1. **Immediate Retry**: Thundering herd problem where failed requests immediately flood the recovering service, knocking it offline again.
2. **Fixed Delay**: Lacks adaptability; short fixed delays do not provide sufficient breathing room for systemic recovery, whereas long fixed delays introduce excessive latency for brief glitches.
3. **In-Memory Worker Sleep (`setTimeout`)**: Holding an unacknowledged message in memory while sleeping blocks the worker consumer channel and delays subsequent message processing, reducing overall pipeline throughput.

## Decision
We implemented a Domain-Driven **Exponential Backoff Retry Strategy** combined with RabbitMQ **Message TTL and Dead Lettering (AMQP delay queues)**:

1. **Exponential Backoff Formula**:
   $$\text{Delay}_n = \text{baseDelay} \times \text{multiplier}^{(n - 1)}$$
   With defaults:
   - Attempt 1: $1000 \text{ ms} \times 4^0 = 1000 \text{ ms}$ (1s)
   - Attempt 2: $1000 \text{ ms} \times 4^1 = 4000 \text{ ms}$ (4s)
   - Attempt 3: $1000 \text{ ms} \times 4^2 = 16000 \text{ ms}$ (16s)
   - Max attempts: 3. Beyond 3 attempts, the message transitions to `certificate.dlq`.

2. **Non-blocking Infrastructure Execution (Dead-Letter Delay Queues)**:
   Instead of keeping Node.js worker event-loop timers active:
   - Dedicated delay queues are declared: `certificate.retry.1000`, `certificate.retry.4000`, `certificate.retry.16000`.
   - Each delay queue is configured with `x-message-ttl` equal to the delay, and `x-dead-letter-exchange` routing back to the primary exchange/queue (`certificate.generate`).
   - When a transient failure occurs, the worker publishes the message to the corresponding delay queue with incremented attempt headers and immediately issues `basic.ack` on the original delivery.
   - Once the TTL expires in RabbitMQ, the broker automatically transfers the message back to `certificate.generate` for its next attempt.

## Consequences

### Positive
- **High Concurrency & Non-Blocking Worker**: Node.js workers remain 100% available to process other jobs; worker threads never block on sleep/timers.
- **Progressive External System Relief**: Increasing delays give external dependencies compounding recovery windows.
- **Crash Resilience**: Because delayed messages reside safely on durable RabbitMQ queues with TTL, worker process crashes or restarts do not lose messages or pending retry timers.
- **Deterministic Bounds**: Clear maximum retry budget prevents infinite reprocessing cycles.

### Negative / Trade-offs
- **Queue Count Overhead**: Requires declaring and maintaining multiple retry queues in RabbitMQ topology for each unique delay interval.
- **Clock Dependency on Broker**: RabbitMQ node internal clocks manage message expiration and TTL delivery.

## Implementation References
- Domain retry strategy & backoff calculations: `src/domain/services/retry-strategy.ts`
- Delay queue topology declarations: `src/infrastructure/queue/certificate-topology.ts`
- Retry routing in Use Case: `src/application/use-cases/generate-certificate.use-case.ts`
- Integration specifications: `SPEC.md`
