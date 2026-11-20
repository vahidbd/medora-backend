import { z } from 'zod';
import { FLAG_KINDS, FLAG_OUTCOMES, FLAG_STATUSES, FLAG_URGENCIES } from '../../db/schema/values.js';

/** Request and reply shapes for adherence (ADR 0014). Field names follow GLOSSARY.md. */

export const appOpenedReply = z.object({
  /** The patient's calendar day it counted for (ADH2). */
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const adherenceFlagKind = z.enum(FLAG_KINDS);

export const adherenceFlagListQuery = z
  .object({
    status: z.enum(FLAG_STATUSES).default('open'),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

export const adherenceFlagParams = z.object({ adherenceFlagId: z.uuid() }).strict();

const resolution = z.object({
  outcome: z.enum(FLAG_OUTCOMES),
  resolvedAt: z.iso.datetime({ offset: true }),
  resolvedBy: z.object({ userId: z.uuid(), displayName: z.string().nullable() }),
});

export const adherenceFlagSummary = z.object({
  adherenceFlagId: z.uuid(),
  patientId: z.uuid(),
  /** Preferred (or given) name, then family name. */
  patientName: z.string(),
  kind: adherenceFlagKind,
  urgency: z.enum(FLAG_URGENCIES),
  status: z.enum(FLAG_STATUSES),
  raisedAt: z.iso.datetime({ offset: true }),
  /** The side effect report that raised it, for `side_effect_reported`: read it from GET /v1/side-effects/:sideEffectId. */
  sideEffectId: z.uuid().nullable(),
  /** The resolved flag this one reopens (ADH7). */
  reopenedFromId: z.uuid().nullable(),
  resolution: resolution.nullable(),
});

export const adherenceFlagListReply = z.object({ adherenceFlags: z.array(adherenceFlagSummary) });

const resolutionWithNote = resolution.extend({ note: z.string().nullable() });

export const adherenceFlagDetail = adherenceFlagSummary.extend({
  resolution: resolutionWithNote.nullable(),
  reopenedFrom: resolutionWithNote.nullable(),
});

export const resolveAdherenceFlagBody = z
  .object({
    outcome: z.enum(FLAG_OUTCOMES),
    /** Clinical text: kept on the flag only (ADH7). */
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
