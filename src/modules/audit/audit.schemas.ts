import { z } from 'zod';
import { ACTOR_TYPES, DATA_ZONES } from '../../db/schema/values.js';

/** Reading the tenant's audit log (docs/decisions/admin.md ADM25, ADM26). */

const iso = z.iso.datetime();

export const auditEntry = z.object({
  /** The entry's number; later entries have higher numbers. */
  entryId: z.string(),
  at: iso,
  actorType: z.enum(ACTOR_TYPES),
  /** The person's user id or the agent's id; null for Medora itself. */
  actorId: z.uuid().nullable(),
  /** The person's name or email, when they belong to this tenant; null for an agent, Medora, or someone outside it. */
  actorName: z.string().nullable(),
  action: z.string(),
  zone: z.enum(DATA_ZONES),
  recordTable: z.string(),
  recordId: z.string(),
  requestId: z.string().nullable(),
  /** Ids and facts only, never names, contact details or clinical text (ADR 0008). */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type AuditEntryView = z.infer<typeof auditEntry>;

const filterFields = {
  /** From this instant, inclusive. */
  from: iso.optional(),
  /** Up to this instant, exclusive. */
  to: iso.optional(),
  actorId: z.uuid().optional(),
  /** An action, or the start of one: `brand.` finds every brand action. */
  action: z.string().trim().min(1).max(80).optional(),
  recordTable: z.string().trim().min(1).max(80).optional(),
  recordId: z.string().trim().min(1).max(80).optional(),
  zone: z.enum(DATA_ZONES).optional(),
};

export const auditFilter = z.object(filterFields).strict();
export type AuditFilter = z.infer<typeof auditFilter>;

export const auditQuery = z
  .object({
    ...filterFields,
    /** The page after this entry: the previous reply's `nextBefore`. */
    before: z.string().regex(/^[0-9]{1,18}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuery>;

export const auditPage = z.object({
  entries: z.array(auditEntry),
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: z.string().nullable(),
});

export const auditExport = z.object({
  entries: z.array(auditEntry),
  /** More entries matched than an export holds; narrow the filter to get the rest. */
  truncated: z.boolean(),
});
