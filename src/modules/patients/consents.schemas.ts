import { z } from 'zod';
import { CONSENT_DECISIONS, CONSENT_KINDS } from '../../db/schema/values.js';

/** Request and reply shapes for consents (IDN12 to IDN14). */

export const consentKindSchema = z.enum(CONSENT_KINDS);

export const consentDocument = z.object({
  documentId: z.uuid(),
  kind: consentKindSchema,
  version: z.number().int(),
  title: z.string(),
  body: z.string(),
  publishedAt: z.iso.datetime({ offset: true }),
});

export const consentState = z.object({
  kind: consentKindSchema,
  document: consentDocument.nullable(),
  decision: z.enum(CONSENT_DECISIONS).nullable(),
  decidedVersion: z.number().int().nullable(),
  needed: z.boolean(),
});

export const consentStatesReply = z.object({ consents: z.array(consentState) });
export const consentDocumentsReply = z.object({ documents: z.array(consentDocument) });

export const publishConsentBody = z
  .object({ kind: consentKindSchema, title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(50_000) })
  .strict();

/** A patient agreeing to the current version, in the patient app. Withdrawing goes through support (IDN13). */
export const giveConsentBody = z.object({ documentId: z.uuid() }).strict();

/** Staff recording a decision the patient made by phone or in person, with the reason. */
export const recordConsentBody = z
  .object({
    documentId: z.uuid(),
    decision: z.enum(CONSENT_DECISIONS),
    channel: z.enum(['phone', 'in_person']),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
