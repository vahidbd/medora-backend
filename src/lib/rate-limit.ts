import { pool } from '../db/client.js';

/**
 * The one rate limiter (ADR 0030): fixed windows counted in Postgres, so
 * every copy of the API counts the same attempts. Keyed on a limit's name and
 * a trusted subject, usually request.clientIp.
 */
export interface Limit {
  name: string;
  max: number;
  windowSeconds: number;
}

export interface LimitState {
  count: number;
  retryAfterSeconds: number;
}

/** Count one attempt and return the window's count so far. */
export async function countAttempt(limit: Limit, subject: string): Promise<LimitState> {
  const { rows } = await pool.query<{ count: number; retry_after: number }>(
    `insert into platform.rate_limit_counters as c (key, window_started_at, count)
     values ($1, now(), 1)
     on conflict (key) do update set
       window_started_at = case when c.window_started_at <= now() - make_interval(secs => $2) then now() else c.window_started_at end,
       count = case when c.window_started_at <= now() - make_interval(secs => $2) then 1 else c.count + 1 end
     returning count, ceil(extract(epoch from (window_started_at + make_interval(secs => $2) - now())))::int as retry_after`,
    [`${limit.name}:${subject}`, limit.windowSeconds],
  );
  const row = rows[0];
  return { count: row?.count ?? 1, retryAfterSeconds: Math.max(1, row?.retry_after ?? limit.windowSeconds) };
}

/** Seconds until the subject may try again, or null when it is under the limit. Counts nothing. */
export async function blockedFor(limit: Limit, subject: string): Promise<number | null> {
  const { rows } = await pool.query<{ count: number; retry_after: number }>(
    `select count, ceil(extract(epoch from (window_started_at + make_interval(secs => $2) - now())))::int as retry_after
       from platform.rate_limit_counters
      where key = $1 and window_started_at > now() - make_interval(secs => $2)`,
    [`${limit.name}:${subject}`, limit.windowSeconds],
  );
  const row = rows[0];
  return row && row.count >= limit.max ? Math.max(1, row.retry_after) : null;
}
