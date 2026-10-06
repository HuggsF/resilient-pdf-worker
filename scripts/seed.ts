import '../src/module-aliases';
import { CERTIFICATE_QUEUES } from '@application/services/certificate-queues';
import { encodeCertificateJob } from '@application/services/certificate-job.codec';
import { Certificate } from '@domain/entities/certificate.entity';
import { loadConfig, loadEnvFile } from '@infrastructure/config/env';
import { createDatabase } from '@infrastructure/database/knex';
import { migrateLatest } from '@infrastructure/database/migrator';
import { MySqlCertificateRepository } from '@infrastructure/database/mysql-certificate.repository';
import { createLogger } from '@infrastructure/logging/logger';
import { describeTopology } from '@infrastructure/queue/certificate-topology';
import { connectRabbitMq } from '@infrastructure/queue/rabbitmq-connection';
import { RabbitMqMessageBroker } from '@infrastructure/queue/rabbitmq-message-broker';
import { UuidV7IdGenerator } from '@infrastructure/system/uuid-v7-id-generator';

const SEED_DATA = [
  {
    studentId: 'student-001',
    studentName: 'Ada Lovelace',
    courseName: 'Clean Architecture with Node.js',
    completionDate: '2026-05-15',
  },
  {
    studentId: 'student-002',
    studentName: 'Alan Turing',
    courseName: 'Domain-Driven Design in Practice',
    completionDate: '2026-06-20',
  },
  {
    studentId: 'student-003',
    studentName: 'Grace Hopper',
    courseName: 'Resilient Microservices with RabbitMQ',
    completionDate: '2026-07-10',
  },
  {
    studentId: 'student-004',
    studentName: 'Margaret Hamilton',
    courseName: 'Fault Tolerance & Chaos Engineering',
    completionDate: '2026-08-01',
  },
  {
    studentId: 'student-005',
    studentName: 'Edsger Dijkstra',
    courseName: 'Concurrent Systems & Message Queues',
    completionDate: '2026-09-12',
  },
];

const main = async (): Promise<void> => {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ ...config.log, name: 'pdf-seed' });
  const idGenerator = new UuidV7IdGenerator();
  const db = createDatabase(config.database);

  logger.info('Starting seed execution...');
  await migrateLatest(db);

  const repository = new MySqlCertificateRepository(db);

  let connection = null;
  let broker = null;

  try {
    const topology = describeTopology([1000, 4000, 16000, 30000]);
    connection = await connectRabbitMq({
      ...config.rabbitmq,
      connectionName: 'resilient-pdf-worker:seed',
      logger,
    });
    broker = await RabbitMqMessageBroker.create(connection, {
      topology,
      prefetch: 10,
      logger,
    });

    const seededIds: string[] = [];

    for (const data of SEED_DATA) {
      const id = idGenerator.generate();
      const certResult = Certificate.create({
        id,
        studentId: data.studentId,
        studentName: data.studentName,
        courseName: data.courseName,
        completionDate: data.completionDate,
        createdAt: new Date(),
      });

      if (!certResult.success) {
        logger.error({ err: certResult.error }, 'Failed to create seed certificate entity');
        continue;
      }

      await repository.save(certResult.data);
      await broker.publish(
        CERTIFICATE_QUEUES.generate,
        encodeCertificateJob({ certificateId: id }),
      );
      seededIds.push(id);
      logger.info(
        { id, student: data.studentName, course: data.courseName },
        'Seeded and enqueued certificate',
      );
    }

    const stats = await repository.countByStatus();
    logger.info(
      { totalSeeded: seededIds.length, statusStats: stats },
      'Seed successfully completed',
    );
  } catch (error: unknown) {
    logger.error({ err: error }, 'Seed execution failed');
    throw error;
  } finally {
    if (broker) {
      await broker.close().catch(() => undefined);
    }
    if (connection) {
      await connection.close().catch(() => undefined);
    }
    await db.destroy();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`Fatal seed error: ${String(error)}\n`);
  process.exit(1);
});
