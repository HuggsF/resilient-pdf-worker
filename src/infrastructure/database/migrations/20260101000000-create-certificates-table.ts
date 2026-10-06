import type { Knex } from 'knex';

export const name = '20260101000000_create_certificates_table';

/** Schema from the project CLAUDE.md (status tracking of every certificate). */
export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('certificates', (table) => {
    table.charset('utf8mb4');
    table.string('id', 36).primary();
    table.string('student_id', 36).notNullable();
    table.string('student_name', 100).notNullable();
    table.string('course_name', 200).notNullable();
    table.date('completion_date').notNullable();
    table
      .enu('status', ['pending', 'processing', 'completed', 'failed', 'dead_letter'])
      .notNullable()
      .defaultTo('pending');
    table.string('pdf_url', 500).nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table
      .timestamp('updated_at')
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    table.index(['status'], 'idx_status');
    table.index(['student_id'], 'idx_student');
  });
};

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('certificates');
};
