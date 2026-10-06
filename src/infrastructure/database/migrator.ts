import type { Knex } from 'knex';
import * as createCertificatesTable from './migrations/20260101000000-create-certificates-table';

type InCodeMigration = Knex.Migration & { readonly name: string };

/** Ordered list of migrations. New migrations are appended here. */
const MIGRATIONS: readonly InCodeMigration[] = [createCertificatesTable];

/**
 * Migrations are imported as modules instead of being discovered on disk, so they work the
 * same under tsx (src/*.ts), Jest and the compiled build (dist/*.js) without any glob config.
 */
class InCodeMigrationSource implements Knex.MigrationSource<InCodeMigration> {
  getMigrations(): Promise<InCodeMigration[]> {
    return Promise.resolve([...MIGRATIONS]);
  }

  getMigrationName(migration: InCodeMigration): string {
    return migration.name;
  }

  getMigration(migration: InCodeMigration): Promise<Knex.Migration> {
    return Promise.resolve(migration);
  }
}

const migrationConfig = (): Knex.MigratorConfig => ({
  migrationSource: new InCodeMigrationSource(),
  tableName: 'knex_migrations',
});

const appliedNames = (result: unknown): string[] => {
  const log: unknown = Array.isArray(result) ? result[1] : [];
  return Array.isArray(log)
    ? log.filter((entry): entry is string => typeof entry === 'string')
    : [];
};

/** Applies pending migrations and returns their names. */
export const migrateLatest = async (db: Knex): Promise<string[]> => {
  const result: unknown = await db.migrate.latest(migrationConfig());
  return appliedNames(result);
};

/** Reverts the last batch of migrations and returns their names. */
export const migrateRollback = async (db: Knex): Promise<string[]> => {
  const result: unknown = await db.migrate.rollback(migrationConfig());
  return appliedNames(result);
};
