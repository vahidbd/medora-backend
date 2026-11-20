#!/usr/bin/env node
/**
 * `npm run db:setup`: once, on a development machine. Creates the local roles
 * and databases Medora expects (ADR 0006), on a local Postgres 16 only.
 *
 *   medora_owner      owns the tables, runs migrations (password medora_owner)
 *   medora_app        the API's group role, owns nothing
 *   medora_marketing  marketing jobs' group role, never sees clinical data
 *   medora_api        the API's login, a member of medora_app (password medora_api)
 *
 * DATABASE_ADMIN_URL names a superuser on the local server
 * (default postgres://postgres:postgres@127.0.0.1:5432/postgres).
 */
import pg from 'pg';

const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const host = new URL(adminUrl.replace(/^postgres(ql)?:/, 'http:')).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(host)) {
  console.error('db:setup only runs against a local Postgres.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();

async function ensureRole(name, attributes) {
  const { rowCount } = await client.query('select 1 from pg_roles where rolname = $1', [name]);
  if (rowCount === 0) await client.query(`create role ${name} ${attributes}`);
}

try {
  await ensureRole('medora_app', 'nologin nosuperuser nobypassrls');
  await ensureRole('medora_marketing', 'nologin nosuperuser nobypassrls');
  await ensureRole('medora_owner', "login createrole password 'medora_owner'");
  await ensureRole('medora_api', "login nosuperuser nobypassrls password 'medora_api' in role medora_app");
  for (const name of ['medora']) {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (rowCount === 0) await client.query(`create database ${name} owner medora_owner`);
  }
  console.log('Local roles and the medora database are ready. Next: npm run db:migrate && npm run db:seed');
} finally {
  await client.end();
}
