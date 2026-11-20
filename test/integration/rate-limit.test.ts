import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { FAILED_SIGN_IN_LIMIT } from '../../src/plugins/auth.js';
import { blockedFor, countAttempt } from '../../src/lib/rate-limit.js';
import { testApp } from '../support/app.js';
import { admin } from '../support/db.js';

/** One rate limiter, counted in Postgres (ADR 0030). */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

describe('the rate limiter', () => {
  const limit = { name: `test-${randomUUID()}`, max: 3, windowSeconds: 60 };

  it('counts attempts and blocks at the limit', async () => {
    expect(await blockedFor(limit, '203.0.113.1')).toBeNull();
    for (let i = 0; i < 3; i += 1) await countAttempt(limit, '203.0.113.1');
    expect(await blockedFor(limit, '203.0.113.1')).toBeGreaterThan(0);
    expect(await blockedFor(limit, '203.0.113.2')).toBeNull();
  });

  it('counts concurrent attempts exactly', async () => {
    const subject = randomUUID();
    await Promise.all(Array.from({ length: 10 }, () => countAttempt(limit, subject)));
    const { rows } = await admin.query('select count from platform.rate_limit_counters where key = $1', [`${limit.name}:${subject}`]);
    expect(rows[0].count).toBe(10);
  });

  it('starts a new window once the old one has passed', async () => {
    const subject = randomUUID();
    for (let i = 0; i < 3; i += 1) await countAttempt(limit, subject);
    await admin.query("update platform.rate_limit_counters set window_started_at = now() - interval '61 seconds' where key = $1", [`${limit.name}:${subject}`]);
    expect(await blockedFor(limit, subject)).toBeNull();
    expect((await countAttempt(limit, subject)).count).toBe(1);
  });

  it('blocks an address after too many failed sign-ins', async () => {
    const address = '127.0.0.1';
    await admin.query('insert into platform.rate_limit_counters (key, window_started_at, count) values ($1, now(), $2) on conflict (key) do update set window_started_at = now(), count = $2', [
      `${FAILED_SIGN_IN_LIMIT.name}:${address}`,
      FAILED_SIGN_IN_LIMIT.max,
    ]);
    const reply = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer anything' } });
    expect(reply.statusCode).toBe(429);
    expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
    await admin.query('delete from platform.rate_limit_counters where key = $1', [`${FAILED_SIGN_IN_LIMIT.name}:${address}`]);
  });
});
