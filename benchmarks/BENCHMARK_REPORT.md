# Benchmark Report — resilient-pdf-worker

**Data do Teste:** 2026-10-06T15:56:44.062Z  
**Ambiente:** Node.js v24.19.0 | win32 x64  

## 1. Identificadores: UUID v7 vs UUID v4
| Algoritmo | Throughput (ops/sec) | Ordenação Monotônica | Impacto InnoDB / MySQL |
|---|---|---|---|
| **UUID v7 (RFC 9562)** | **1,379,694.76** | **SIM (100% sequencial)** | **Zero Page-Splits (Append-only)** |
| UUID v4 (Aleatório) | 803,999.41 | NÃO (Aleatório) | Fragmentação de B+Tree e I/O elevado |

## 2. Circuit Breaker: Redução de Latência em Degradação
Simulação de 100 requisições concorrentes com API externa sofrendo indisponibilidade (timeout 50ms):
- **Tempo sem proteção (espera de timeouts):** 5,888.87 ms
- **Tempo com Circuit Breaker (Fail-Fast):** 279.75 ms
- **Tempo Economizado de Event Loop / CPU:** **5,609.11 ms**
- **Aceleração (Speedup):** **21.05x**

## 3. Pipeline de Consumo & Garantia de Zero Mensagens Perdidas
Lote de **1.000 mensagens** processadas via `GenerateCertificateUseCase`:

| Métrica | Cenário A (Normal: 0% falha) | Cenário B (Caos: 50% falha externa) |
|---|---|---|
| **Vazão (Throughput)** | **88,838.35 msg/sec** | **146,470.79 msg/sec** |
| **Latência Média (p50)** | 0.01 ms | 0.01 ms |
| **Latência p95** | 0.03 ms | 0.01 ms |
| **Latência p99** | 0.07 ms | 0.02 ms |
| **Certificados Concluídos** | 1000 | 503 |
| **Retries Roteados (Delay AMQP)** | 0 | 497 |
| **Dead Letter Queue (DLQ)** | 0 | 0 |
| **Taxa de Mensagens Perdidas** | **0.00% (Zero)** | **0.00% (Zero)** |

---
*Relatório gerado automaticamente por `npm run bench`.*
