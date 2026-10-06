import '../../module-aliases';
import { loadConfig, loadEnvFile } from '@infrastructure/config/env';
import { createDatabase } from '@infrastructure/database/knex';
import { migrateLatest, migrateRollback } from '@infrastructure/database/migrator';
import { createLogger } from '@infrastructure/logging/logger';

/** `npm run migrate` / `npm run migrate:rollback` */
const main = async (): Promise<void> => {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ ...config.log, name: 'pdf-migrate' });
  const db = createDatabase(config.database);
  try {
    const rollback = process.argv.includes('--rollback');
    const applied = rollback ? await migrateRollback(db) : await migrateLatest(db);
    logger.info(
      { applied, rollback },
      applied.length > 0 ? 'Migrations applied' : 'Database already up to date',
    );
  } finally {
    await db.destroy();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed\n${String(error)}\n`);
  process.exit(1);
});
