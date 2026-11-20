import { describe, expect, it } from 'vitest';
import { assertCents, gstIncluded, sumCents } from '../../src/lib/money.js';

/** Money in whole cents, and GST as one eleventh of an inclusive price (ADR 0016, docs/decisions/billing.md BIL7). */
describe('money', () => {
  it('works out the GST inside an inclusive price, to the nearest cent', () => {
    expect([1100, 19900, 5, 6, 17, 0, -1100].map(gstIncluded)).toEqual([100, 1809, 0, 1, 2, 0, -100]);
  });

  it('refuses fractions of a cent and amounts past the safe range', () => {
    expect(() => assertCents(10.5)).toThrow(RangeError);
    expect(() => gstIncluded(0.1)).toThrow(RangeError);
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
    expect(sumCents([150, -50, 1])).toBe(101);
  });
});
