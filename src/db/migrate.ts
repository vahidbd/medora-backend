import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Apply pending migrations as the owner (DATABASE_MIGRATION_URL), on a
 * connection of its own, under an advisory lock so two copies starting at
 * once take turns (ADR 0015). The deploy runs this before the new release
 * takes traffic, so a failed migration keeps the previous release serving.
 */
const MIGRATION_LOCK = 'medora.migrate';

export const migrationsFolder = new URL('./migrations', import.meta.url).pathname;

export async function migrateDatabase(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, application_name: 'medora-migrate' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]).catch(() => undefined);
    await client.end();
  }
}
