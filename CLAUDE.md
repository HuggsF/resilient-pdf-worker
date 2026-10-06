# CLAUDE.md — resilient-pdf-worker

## Project Context
This project demonstrates resilient message queue consumption with RabbitMQ. When an external PDF API fails, messages are retried with exponential backoff and eventually routed to a Dead Letter Queue. A circuit breaker prevents overwhelming the failing API.

## Key Constraints
- MUST use amqplib for RabbitMQ communication
- MUST configure DLQ via x-dead-letter-exchange on the main queue
- MUST implement retry with exponential backoff (3 attempts: 1s, 4s, 16s)
- MUST implement circuit breaker with opossum
- MUST track certificate status in MySQL
- MUST include a flaky PDF server for chaos testing
- MUST never ack a message before processing is confirmed
- Worker and API should be separate processes (separate entry points)

## Implementation Order
1. Domain: Certificate entity with status transitions, value objects
2. Domain: repository and service interfaces (ports)
3. Application: GenerateCertificateUseCase, EnqueueCertificateUseCase, ReprocessDLQUseCase
4. Infrastructure: RabbitMQ message broker adapter (queues, DLQ, exchanges)
5. Infrastructure: MySQL certificate repository
6. Infrastructure: PDF generator service with circuit breaker
7. Infrastructure: Retry strategy with exponential backoff
8. Presentation: Express API (producer)
9. Presentation: Worker process (consumer)
10. Chaos: Flaky PDF server
11. Tests: unit -> integration -> e2e
12. Docker Compose with all services

## Project-Specific Dependencies
- amqplib, opossum, express, mysql2, knex, uuid
- supertest (dev)

## Database Schema
```sql
CREATE TABLE certificates (
  id VARCHAR(36) PRIMARY KEY,
  student_id VARCHAR(36) NOT NULL,
  student_name VARCHAR(100) NOT NULL,
  course_name VARCHAR(200) NOT NULL,
  completion_date DATE NOT NULL,
  status ENUM('pending','processing','completed','failed','dead_letter') NOT NULL DEFAULT 'pending',
  pdf_url VARCHAR(500) NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_student (student_id)
);
```
