import { describe, expect, it } from 'vitest';
import { maskText, safeErrorMessage } from '../../src/lib/redact.js';

describe('masking free text (ADR 0026)', () => {
  it('masks emails and long numbers, and leaves ids alone', () => {
    expect(maskText('sent to someone@example.test at 0412 345 678')).toBe('sent to [email] at [number]');
    expect(maskText('Medicare 2123456701')).toBe('Medicare [number]');
    expect(maskText('tenant 52354310-6afc-478d-ae76-89c8fcb1ca6a')).toBe('tenant 52354310-6afc-478d-ae76-89c8fcb1ca6a');
    expect(maskText('order 1234567')).toBe('order 1234567');
  });

  it("drops a failed query's parameters", () => {
    const error = new Error('Failed query: select 1 where email = $1\nparams: someone@example.test');
    expect(safeErrorMessage(error)).toBe('Failed query: select 1 where email = $1\nparams: [left out]');
  });
});
