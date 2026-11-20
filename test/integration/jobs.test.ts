import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { forEachTenant, runDueJobs, type Job } from '../../src/lib/jobs.js';
import { acquireLease, expireHeldLeases, releaseLease, withLease } from '../../src/lib/leases.js';
import { admin, createTenant } from '../support/db.js';
import { recordingLog } from '../support/log.js';

/** One run of a job at a time, and only when it is due (ADR 0029, docs/decisions/jobs.md). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

const jobName = () => `test-${randomUUID().slice(0, 8)}`;
const leaseRow = async (name: string) =>
  (await admin.query('select holder, last_outcome, last_finished_at from platform.job_leases where name = $1', [name])).rows[0];

describe('leases', () => {
  it('lets one holder at a time take a lease', async () => {
    const name = jobName();
    const [first, second] = await Promise.all([acquireLease(name), acquireLease(name)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await releaseLease((first ?? second)!, 'succeeded');
    expect(await acquireLease(name)).not.toBeNull();
  });

  it('takes over a lease whose holder let it run out, and says from whom', async () => {
    const name = jobName();
    const dead = await acquireLease(name);
    await admin.query(`update platform.job_leases set expires_at = now() - interval '1 second' where name = $1`, [name]);
    const next = await acquireLease(name);
    expect(next?.tookOverFrom).toBe(dead?.holder);
  });

  it('hands every lease this process holds to the next process on shutdown', async () => {
    const name = jobName();
    await acquireLease(name);
    expect(await expireHeldLeases()).toBeGreaterThanOrEqual(1);
    expect(await acquireLease(name)).not.toBeNull();
  });

  it('records a run that throws as failed, and releases its lease', async () => {
    const name = jobName();
    await expect(withLease(name, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await leaseRow(name)).toMatchObject({ holder: null, last_outcome: 'failed' });
  });
});

describe('runDueJobs', () => {
  it('runs a job once, then not again until it is due', async () => {
    let runs = 0;
    const job: Job = { name: jobName(), everySeconds: 3600, run: async () => void (runs += 1) };
    const log = recordingLog();
    expect(await runDueJobs([job], log)).toEqual([{ name: job.name, ran: true, outcome: 'succeeded' }]);
    expect(await runDueJobs([job], log)).toEqual([{ name: job.name, ran: false }]);
    await admin.query(`update platform.job_leases set last_started_at = now() - interval '2 hours' where name = $1`, [job.name]);
    await runDueJobs([job], log);
    expect(runs).toBe(2);
  });

  it("keeps running the other jobs when one fails, and records the failure", async () => {
    const ok: Job = { name: jobName(), everySeconds: 60, run: async () => undefined };
    const bad: Job = { name: jobName(), everySeconds: 60, run: async () => Promise.reject(new Error('nope')) };
    const log = recordingLog();
    const results = await runDueJobs([bad, ok], log);
    expect(results).toEqual([
      { name: bad.name, ran: true, outcome: 'failed' },
      { name: ok.name, ran: true, outcome: 'succeeded' },
    ]);
    expect(await leaseRow(bad.name)).toMatchObject({ last_outcome: 'failed' });
    expect(log.lines.some((line) => line.level === 'error' && line.message === 'job failed')).toBe(true);
  });

  it('skips a job another process is running', async () => {
    const job: Job = { name: jobName(), everySeconds: 1, run: async () => undefined };
    const elsewhere = await acquireLease(job.name);
    expect(elsewhere).not.toBeNull();
    expect(await runDueJobs([job], recordingLog())).toEqual([{ name: job.name, ran: false }]);
  });
});

describe('forEachTenant', () => {
  it('works inside each tenant in turn, and carries on past a tenant that fails', async () => {
    const good = await createTenant();
    const bad = await createTenant();
    const seen: string[] = [];
    const log = recordingLog();
    await expect(
      forEachTenant({ name: 'test-each', log }, async (tx) => {
        if (tx.context.tenantId === bad) throw new Error('bad row');
        seen.push(tx.context.tenantId);
      }),
    ).rejects.toThrow(/failed for 1 of/);
    expect(seen).toContain(good);
    expect(log.lines.find((line) => line.message === 'job failed for a tenant')?.details).toMatchObject({ tenantId: bad });
  });
});
