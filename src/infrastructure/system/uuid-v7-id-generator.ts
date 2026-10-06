import { v7 as uuidv7 } from 'uuid';
import type { IdGenerator } from '@application/interfaces/id-generator';

/**
 * Time-ordered UUIDs (RFC 9562 v7). Sequential primary keys append to the end of the InnoDB
 * clustered index instead of splitting random pages like UUID v4 — faster bulk inserts.
 */
export class UuidV7IdGenerator implements IdGenerator {
  generate(): string {
    return uuidv7();
  }
}
