import { knex } from 'knex';
import type { Knex } from 'knex';
import type { DatabaseConfig } from '@infrastructure/config/env';

type RawConnection = {
  query: (sql: string, callback: (error: Error | null) => void) => void;
};

/** MySQL connection pool (mysql2 driver). Every session runs in UTC. */
export const createDatabase = (config: DatabaseConfig): Knex =>
  knex({
    client: 'mysql2',
    connection: {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.name,
      charset: 'utf8mb4',
      timezone: 'Z',
      // DATE/TIMESTAMP come back as strings: no implicit time-zone conversion by the driver.
      dateStrings: true,
    },
    pool: {
      min: config.pool.min,
      max: config.pool.max,
      // TIMESTAMP columns are converted to the *session* time zone: pin it to UTC.
      afterCreate: (
        connection: RawConnection,
        done: (error: Error | null, connection: RawConnection) => void,
      ): void => {
        connection.query("SET time_zone = '+00:00'", (error) => {
          done(error, connection);
        });
      },
    },
  });

export const pingDatabase = async (db: Knex): Promise<void> => {
  await db.raw('SELECT 1');
};
