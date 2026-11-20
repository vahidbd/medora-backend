import { assertSafeDatabaseRole } from './role-check.js';
import { pool } from './client.js';

/** `select 1` with a deadline, so a wedged pool can't hang the readiness check. */
export async function pingDatabase(timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('select 1'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`database ping took over ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function checkDatabaseRole(): Promise<void> {
  return assertSafeDatabaseRole(pool);
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
