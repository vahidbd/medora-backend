/**
 * Money is a whole number of cents (ADR 0016): `bigint` in the database,
 * a safe integer here, never a float. Prices are GST-inclusive, as the
 * patient sees them (docs/decisions/billing.md BIL7).
 */
export type Cents = number;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertCents(value: number, what = 'An amount'): Cents {
  if (!isCents(value)) throw new RangeError(`${what} must be a whole number of cents`);
  return value;
}

/** The sum of amounts, refusing to lose a cent past the safe integer range. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) total = assertCents(total + assertCents(value), 'A total');
  return total;
}

/**
 * The GST inside a GST-inclusive amount: one eleventh, rounded to the
 * nearest cent with halves away from zero (BIL7). Worked out per line, so
 * an invoice's GST is the sum of its lines'.
 */
export function gstIncluded(amount: Cents): Cents {
  assertCents(amount);
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  return sign * Math.floor((abs * 2 + 11) / 22);
}
