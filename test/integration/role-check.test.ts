import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { pool } from '../../src/db/client.js';
import { databaseRoleProblems } from '../../src/db/role-check.js';
import { admin } from '../support/db.js';

/** The API refuses a role row-level security doesn't bind (ADRs 0006, 0025). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

describe('the database role check', () => {
  it('accepts medora_api', async () => {
    expect(await databaseRoleProblems(pool)).toEqual([]);
  });

  it('refuses a superuser', async () => {
    const problems = await databaseRoleProblems(admin);
    expect(problems.join('\n')).toMatch(/superuser/);
  });

  it('refuses a role that owns Medora tables', async () => {
    const client = new pg.Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
    await client.connect();
    try {
      await client.query('begin');
      await client.query("create role medora_test_owner nologin");
      await client.query('alter table platform.outbox owner to medora_test_owner');
      await client.query('set local role medora_test_owner');
      const problems = await databaseRoleProblems(client);
      expect(problems.join('\n')).toMatch(/owns, or can act as the owner of/);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
