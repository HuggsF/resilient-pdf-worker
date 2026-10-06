# ADR-002: Circuit Breaker Pattern for External HTTP Integration

## Status
**Accepted**

## Date
2026-10-06

## Context
Certificate generation requires rendering PDF documents via an external HTTP microservice (`POST /api/generate-pdf`). In distributed systems, external dependencies are prone to degradation, network partitioning, cascading failures, and resource exhaustion.

When the external service becomes degraded or completely unavailable:
1. Continuing to send requests exacerbates pressure on an already struggling external service, preventing its recovery.
2. Worker threads block awaiting request timeouts (e.g., socket or HTTP client timeouts), holding database transactions, memory buffers, and AMQP channels.
3. Rapid cascading failures spread upstream across the worker cluster.

## Decision
We implemented the Circuit Breaker pattern wrapping the `HttpPdfGeneratorService` client using `opossum`.

The circuit breaker maintains three operational states:
- **CLOSED**: Normal operation. All requests pass through to the external service. Successes and failures are measured in a sliding time window (10 seconds).
- **OPEN**: Tripped when failure percentage exceeds the configured threshold (`CB_ERROR_THRESHOLD_PERCENTAGE = 50%`) after a minimum volume of requests (`CB_VOLUME_THRESHOLD = 5`). In this state, requests immediately fail fast locally without attempting HTTP calls or network I/O. Messages are parked into a deferral delay queue without counting against the message's retry budget.
- **HALF-OPEN**: After a cooldown reset period (`CB_RESET_TIMEOUT_MS = 30s`), a canary request is allowed through. If it succeeds, the breaker resets to CLOSED; if it fails, it returns to OPEN for another cooldown period.

Additionally, state transitions trigger an operational alarm (`pdf-api-circuit-open`) monitored in the worker runtime.

## Consequences

### Positive
- **Fail-Fast Protection**: Eliminates socket wait times and thread starvation during outages; failures resolve in sub-millisecond timeframes locally.
- **Upstream Protection & Graceful Degradation**: Protects the downstream rendering service by shedding 100% of incoming load while it recovers.
- **Retry Preservation**: When the circuit is OPEN, messages are routed to a deferral queue (`certificate.retry.30000`) without incrementing their individual failure retry counters (`attempts`), preserving their retry budget for when the service actually recovers.
- **High Observability**: Circuit state transitions and real-time health metrics (volume, error rate, open/closed status) are directly exposed via worker HTTP health endpoints.

### Negative / Trade-offs
- **Stateful Memory Overhead**: Circuit breaker instances track metrics in rolling memory windows.
- **Tuning Sensitivity**: Thresholds (failure rate, volume threshold, reset timeout) must be calibrated according to expected throughput and SLA requirements.

## Implementation References
- Circuit breaker adapter: `src/infrastructure/http/circuit-breaker-pdf-generator.ts`
- External HTTP client: `src/infrastructure/http/http-pdf-generator.service.ts`
- Environment and configuration options: `src/infrastructure/config/env.ts`
- Container wiring & alarm linkage: `src/infrastructure/config/container.ts`
