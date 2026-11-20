import pg from 'pg';
import { remoteDatabaseVariables } from '../src/config/database-guard.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { TEST_API_PASSWORD, TEST_DATABASE_URL, urlFor, workerDatabaseName } from './database-urls.js';

/** Migrate one database, then clone it for each worker (vitest.config.ts). */
export default async function setup(): Promise<void> {
  if (remoteDatabaseVariables({ MEDORA_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL }).length > 0) {
    throw new Error('TEST_DATABASE_URL must point at a local database');
  }
  const template = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const workers = Number(process.env.TEST_WORKERS ?? '1');
  const server = new pg.Client({ connectionString: urlFor('postgres') });
  await server.connect();
  try {
    await server.query(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'medora_app') then create role medora_app nologin; end if;
        if not exists (select from pg_roles where rolname = 'medora_marketing') then create role medora_marketing nologin; end if;
        if not exists (select from pg_roles where rolname = 'medora_api') then
          create role medora_api login nosuperuser nobypassrls password '${TEST_API_PASSWORD}' in role medora_app;
        end if;
      end $$`);
    for (let i = 1; i <= workers; i += 1) await server.query(`drop database if exists ${workerDatabaseName(i)} with (force)`);
    await server.query(`drop database if exists ${template} with (force)`);
    await server.query(`create database ${template}`);
    await migrateDatabase(urlFor(template));
    for (let i = 1; i <= workers; i += 1) await server.query(`create database ${workerDatabaseName(i)} template ${template}`);
  } finally {
    await server.end();
  }
}
