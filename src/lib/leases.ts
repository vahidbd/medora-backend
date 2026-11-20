import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobLeases } from '../db/schema/index.js';
import type { JobOutcome } from '../db/schema/values.js';

/**
 * One run of a job at a time across every process (ADR 0029), through a
 * lease row in platform.job_leases. Not an advisory lock: a pooled
 * connection can take a session lock on one server connection and lose it on
 * another, and a transaction held open for a whole job pins a connection.
 * A lease is taken in one statement, renewed while the work runs, and left to
 * run out when its holder dies, so the next run starts a few minutes later.
 */

/** How long a lease lasts without renewal. */
export const LEASE_TTL_MS = 2 * 60_000;
const RENEW_EVERY_MS = 30_000;

/** This process, for the holder column: readable in the table, unique per run. */
const PROCESS = `${hostname()}:${process.pid}`;

/** Leases this process holds now (holder to name), so a shutdown can give them up. */
const held = new Map<string, string>();

export interface Lease {
  name: string;
  holder: string;
  /** The holder before this one, when it let the lease run out without releasing it (it died mid-run). */
  tookOverFrom: string | null;
}

export interface LeaseOptions {
  ttlMs?: number;
  /** Take it only when the last run started at least this long ago (docs/decisions/jobs.md JOB1). */
  dueAfterSeconds?: number;
}

/** Take the lease, or null when another run holds it or the job isn't due yet. */
export async function acquireLease(name: string, options: LeaseOptions = {}): Promise<Lease | null> {
  const ttlSeconds = (options.ttlMs ?? LEASE_TTL_MS) / 1000;
  const due = options.dueAfterSeconds ?? 0;
  const holder = `${PROCESS}:${randomUUID()}`;
  const result = await db.execute<{ holder: string; previous: string | null }>(sql`
    with previous as (select holder from platform.job_leases where name = ${name})
    insert into platform.job_leases (name, holder, expires_at, last_started_at)
    values (${name}, ${holder}, now() + make_interval(secs => ${ttlSeconds}), now())
    on conflict (name) do update
      set holder = excluded.holder, expires_at = excluded.expires_at, last_started_at = excluded.last_started_at
      where (job_leases.holder is null or job_leases.expires_at < now())
        and (job_leases.last_started_at is null or job_leases.last_started_at <= now() - make_interval(secs => ${due}))
    returning holder, (select holder from previous) as previous
  `);
  const row = result.rows[0];
  if (!row || row.holder !== holder) return null;
  held.set(holder, name);
  return { name, holder, tookOverFrom: row.previous && row.previous !== holder ? row.previous : null };
}

/** Keep the lease; false when it was lost (it ran out and another run took it). */
export async function renewLease(lease: Lease, ttlMs = LEASE_TTL_MS): Promise<boolean> {
  const rows = await db
    .update(jobLeases)
    .set({ expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})` })
    .where(and(eq(jobLeases.name, lease.name), eq(jobLeases.holder, lease.holder)))
    .returning({ name: jobLeases.name });
  if (rows.length === 0) held.delete(lease.holder);
  return rows.length > 0;
}

/** Give the lease up and record how the run ended. */
export async function releaseLease(lease: Lease, outcome: JobOutcome): Promise<void> {
  held.delete(lease.holder);
  await db
    .update(jobLeases)
    .set({ holder: null, expiresAt: null, lastFinishedAt: sql`now()`, lastOutcome: outcome })
    .where(and(eq(jobLeases.name, lease.name), eq(jobLeases.holder, lease.holder)));
}

/**
 * Mark every lease this process still holds as run out, so the next process
 * takes them over at once instead of waiting out the TTL. A shutdown calls it
 * when its time to finish is up. Returns how many.
 */
export async function expireHeldLeases(): Promise<number> {
  const holders = [...held.keys()];
  if (holders.length === 0) return 0;
  held.clear();
  const rows = await db
    .update(jobLeases)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(inArray(jobLeases.holder, holders))
    .returning({ name: jobLeases.name });
  return rows.length;
}

export type LeaseOutcome<T> = { ran: true; value: T; tookOverFrom: string | null } | { ran: false };

/**
 * Run `work` holding the named lease, renewing it as it goes and releasing it
 * at the end, also when `work` throws. `{ ran: false }` without running
 * anything when another run holds it or it isn't due.
 */
export async function withLease<T>(name: string, work: (lease: Lease) => Promise<T>, options: LeaseOptions = {}): Promise<LeaseOutcome<T>> {
  const ttlMs = options.ttlMs ?? LEASE_TTL_MS;
  const lease = await acquireLease(name, options);
  if (!lease) return { ran: false };
  const timer = setInterval(() => {
    // A missed renewal is covered by the TTL; the next tick tries again.
    renewLease(lease, ttlMs).catch(() => undefined);
  }, Math.min(RENEW_EVERY_MS, ttlMs / 3));
  timer.unref();
  let outcome: JobOutcome = 'failed';
  try {
    const value = await work(lease);
    outcome = 'succeeded';
    return { ran: true, value, tookOverFrom: lease.tookOverFrom };
  } finally {
    clearInterval(timer);
    // Left to run out if the database is down.
    await releaseLease(lease, outcome).catch(() => undefined);
  }
}
