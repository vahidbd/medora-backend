/**
 * Postgres refusals answered in plain words (ADR 0028), with no table,
 * column or constraint names. Anything else is a 500.
 */

/** The Postgres error behind `error`; Drizzle wraps it in its own (`cause`). */
export function postgresError(error: unknown): { code: string; message: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return { code, message: String(message ?? '') };
    current = cause;
  }
  return null;
}

export function databaseRefusal(error: unknown): { status: number; code: string; message: string } | null {
  const pg = postgresError(error);
  if (pg?.code === '23514') return { status: 400, code: 'invalid_value', message: "That value isn't allowed here" };
  if (pg?.code === '23503') {
    return /^update or delete on table/i.test(pg.message)
      ? { status: 409, code: 'still_used', message: 'This is still used by other records' }
      : { status: 400, code: 'missing_reference', message: "That refers to a record that doesn't exist" };
  }
  if (pg?.code === '23505') return { status: 409, code: 'already_exists', message: 'That already exists' };
  return null;
}
