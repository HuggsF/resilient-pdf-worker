# Chaos verification — resilient-pdf-worker

- **Date:** 2026-10-06T16:55:05.971Z
- **Environment:** Node v24.19.0 · win32 x64 · 13th Gen Intel(R) Core(TM) i5-13450HX · docker-compose stack (api + worker + RabbitMQ 3 + MySQL 8 + flaky PDF API, 20–80 ms latency)
- **Settled** = no certificate pending/processing/failed in MySQL and the work + retry queues are empty.
- **Lost** = certificates − completed − dead-lettered. **Duplicate PDFs** = PDFs generated twice for the same certificate (counted by the PDF API).

| Scenario | PDF API failure rate | Certificates | Completed | Dead-lettered | Lost | PDF API calls | Calls / certificate | Duplicate PDFs | Circuit breaker | Time to settle |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| **Flaky API** | 30% | 300 | 298 | 2 | **0** | 423 (125 failed) | 1.41 | 0 | 0× open / 0× closed | 24.2 s |
| **DLQ recovery** | 0% | 2 | 2 | 0 | **0** | 2 (0 failed) | 1.00 | 0 | 0× open / 0× closed | 0.7 s |
| **Degraded API** | 70% for 180.0 s | 300 | 300 (78 during the incident) | 0 | **0** | 487 (187 failed) | 1.62 | 0 | 6× open / 4× closed | 213.7 s |
| **Outage** | 100% for 45.0 s | 100 | 100 (0 during the incident) | 0 | **0** | 146 (46 failed) | 1.46 | 0 | 2× open / 1× closed | 91.3 s |

Reproduce: `docker compose up -d --build && npm run bench:chaos`.
