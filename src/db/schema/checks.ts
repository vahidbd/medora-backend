import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** `column IN ('a', 'b')` from a constant in values.ts. */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
  return sql`${column} in (${sql.raw(list)})`;
}
