import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cutToSchema, type JsonSchema } from '../../src/lib/response-schema.js';

describe('cutting a reply to its schema (ADR 0014)', () => {
  const schema = z.object({
    id: z.string(),
    owner: z.object({ email: z.string() }).nullable(),
    items: z.array(z.object({ name: z.string() })),
  });
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as JsonSchema;

  it('leaves out keys the schema does not declare, at every depth', () => {
    const reply = { id: 'a', secretColumn: 1, owner: { email: 'x', clerkUserId: 'u' }, items: [{ name: 'n', extra: true }] };
    expect(cutToSchema(json, reply)).toEqual({ id: 'a', owner: { email: 'x' }, items: [{ name: 'n' }] });
  });

  it('keeps values as they are, even of the wrong type', () => {
    expect(cutToSchema(json, { id: 7, owner: null, items: 'oops' })).toEqual({ id: 7, owner: null, items: 'oops' });
  });
});
