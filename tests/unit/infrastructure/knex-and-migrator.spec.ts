import type { Knex } from 'knex';
import { createDatabase, pingDatabase } from '@infrastructure/database/knex';
import { migrateLatest, migrateRollback } from '@infrastructure/database/migrator';
import * as migration from '@infrastructure/database/migrations/20260101000000-create-certificates-table';

describe('Knex and Migrator Infrastructure', () => {
  it('creates database instance with MySQL client configuration', () => {
    const db = createDatabase({
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'password',
      name: 'test_db',
      pool: { min: 1, max: 5 },
      migrateOnStart: false,
    });

    expect(db).toBeDefined();
    expect(db.client).toBeDefined();
  });

  it('pingDatabase executes raw SELECT 1', async () => {
    const mockDb = {
      raw: jest.fn().mockResolvedValue([[{ 1: 1 }]]),
    } as unknown as Knex;

    await pingDatabase(mockDb);
    expect(mockDb.raw).toHaveBeenCalledWith('SELECT 1');
  });

  it('migrates latest successfully', async () => {
    const mockDb = {
      migrate: {
        latest: jest.fn().mockResolvedValue([1, ['20260101000000_create_certificates_table']]),
      },
    } as unknown as Knex;

    const applied = await migrateLatest(mockDb);
    expect(applied).toEqual(['20260101000000_create_certificates_table']);
    expect(mockDb.migrate.latest).toHaveBeenCalled();
  });

  it('migrates rollback successfully', async () => {
    const mockDb = {
      migrate: {
        rollback: jest.fn().mockResolvedValue([1, ['20260101000000_create_certificates_table']]),
      },
    } as unknown as Knex;

    const rolledBack = await migrateRollback(mockDb);
    expect(rolledBack).toEqual(['20260101000000_create_certificates_table']);
    expect(mockDb.migrate.rollback).toHaveBeenCalled();
  });

  it('executes migration up and down schema builders', async () => {
    const tableBuilder = {
      charset: jest.fn(),
      string: jest.fn().mockReturnThis(),
      primary: jest.fn().mockReturnThis(),
      notNullable: jest.fn().mockReturnThis(),
      date: jest.fn().mockReturnThis(),
      enu: jest.fn().mockReturnThis(),
      defaultTo: jest.fn().mockReturnThis(),
      nullable: jest.fn().mockReturnThis(),
      integer: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
      timestamp: jest.fn().mockReturnThis(),
      index: jest.fn().mockReturnThis(),
    };

    const mockKnex = {
      schema: {
        createTable: jest
          .fn()
          .mockImplementation(
            (_tableName: string, callback: (table: Knex.CreateTableBuilder) => void) => {
              callback(tableBuilder as unknown as Knex.CreateTableBuilder);
              return Promise.resolve();
            },
          ),
        dropTableIfExists: jest.fn().mockResolvedValue(undefined),
      },
      fn: { now: jest.fn().mockReturnValue('NOW()') },
      raw: jest.fn().mockReturnValue('RAW_SQL'),
    } as unknown as Knex;

    await migration.up(mockKnex);
    expect(mockKnex.schema.createTable).toHaveBeenCalledWith('certificates', expect.any(Function));

    await migration.down(mockKnex);
    expect(mockKnex.schema.dropTableIfExists).toHaveBeenCalledWith('certificates');
  });
});
