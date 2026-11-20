import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Made-up data for local development: one tenant with an owner and a
 * clinician. Development only, as the owner role. Never real people, and
 * never a copy of production, not even de-identified.
 */
if (env.MEDORA_ENV !== 'development') throw new Error('The seed is for local development only');
if (!env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required to seed');

const client = new pg.Client({ connectionString: env.DATABASE_MIGRATION_URL });
await client.connect();
try {
  await client.query('begin');
  const tenant = await client.query<{ id: string }>(
    `insert into platform.tenants (name, time_zone) values ('Harbour Health (demo)', 'Australia/Sydney') returning id`,
  );
  const tenantId = tenant.rows[0]?.id;
  for (const [email, role] of [
    ['owner@example.test', 'owner'],
    ['clinician@example.test', 'clinician'],
  ] as const) {
    const user = await client.query<{ id: string }>(
      `insert into platform.users (email) values ($1) on conflict ((lower(email))) do update set email = excluded.email returning id`,
      [email],
    );
    await client.query(`insert into platform.memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [tenantId, user.rows[0]?.id, role]);
  }
  await client.query('commit');
  process.stdout.write(`Seeded tenant ${tenantId} with owner@example.test and clinician@example.test.\nMake a token: npm run dev:token -- owner@example.test\n`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
