import { and, desc, eq, max } from 'drizzle-orm';
import { consentDocuments, patientConsents, patients } from '../../db/schema/index.js';
import { CONSENT_KINDS, type ConsentChannel, type ConsentDecision, type ConsentKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { AppError, BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';

/**
 * Consents (IDN-05, docs/decisions/patients.md IDN12 to IDN14). Each kind is
 * asked when it is needed, against the tenant's current published version,
 * and a new version asks again. Decisions are never edited.
 */

/** Which consents an action needs (IDN13). */
export const CONSENTS_FOR = {
  /** Starting an intake, booking a consult, using the patient app. */
  care: ['privacy', 'telehealth_terms'],
  identity_check: ['identity_check'],
  /** Ordering medicine: the script and order go to the dispensing pharmacy. */
  order: ['privacy', 'telehealth_terms', 'pharmacy_sharing'],
} as const satisfies Record<string, readonly ConsentKind[]>;
export type ConsentPurpose = keyof typeof CONSENTS_FOR;

export interface ConsentDocument {
  documentId: string;
  kind: ConsentKind;
  version: number;
  title: string;
  body: string;
  publishedAt: string;
}

export interface ConsentState {
  kind: ConsentKind;
  /** The tenant's current version, or null if it hasn't published this kind. */
  document: ConsentDocument | null;
  /** The patient's latest decision on this kind, at whichever version. */
  decision: ConsentDecision | null;
  decidedVersion: number | null;
  /** True unless the latest decision is "given" on the current version. */
  needed: boolean;
}

const DOCUMENT_TABLE = 'clinical.consent_documents' as const;
const CONSENT_TABLE = 'clinical.patient_consents' as const;

const documentColumns = {
  documentId: consentDocuments.id,
  kind: consentDocuments.kind,
  version: consentDocuments.version,
  title: consentDocuments.title,
  body: consentDocuments.body,
  publishedAt: consentDocuments.publishedAt,
};

function toDocument(row: { documentId: string; kind: string; version: number; title: string; body: string; publishedAt: Date }): ConsentDocument {
  return { ...row, kind: row.kind as ConsentKind, publishedAt: row.publishedAt.toISOString() };
}

/** Every published version, newest first. */
export async function listConsentDocuments(tx: TenantTx): Promise<ConsentDocument[]> {
  const rows = await tx.db
    .select(documentColumns)
    .from(consentDocuments)
    .where(eq(consentDocuments.tenantId, tx.context.tenantId))
    .orderBy(consentDocuments.kind, desc(consentDocuments.version));
  return rows.map(toDocument);
}

async function currentDocuments(tx: TenantTx): Promise<Map<ConsentKind, ConsentDocument>> {
  const current = new Map<ConsentKind, ConsentDocument>();
  for (const document of await listConsentDocuments(tx)) if (!current.has(document.kind)) current.set(document.kind, document);
  return current;
}

/** Publish a new version of one kind of consent. Published text never changes (IDN14). */
export async function publishConsentDocument(tx: TenantTx, input: { kind: ConsentKind; title: string; body: string }): Promise<ConsentDocument> {
  const { tenantId, actor } = tx.context;
  const [latest] = await tx.db
    .select({ version: max(consentDocuments.version) })
    .from(consentDocuments)
    .where(and(eq(consentDocuments.tenantId, tenantId), eq(consentDocuments.kind, input.kind)));
  const [row] = await tx.db
    .insert(consentDocuments)
    .values({ tenantId, kind: input.kind, version: (latest?.version ?? 0) + 1, title: input.title, body: input.body, publishedBy: actor.type === 'person' ? actor.userId : null })
    .returning(documentColumns);
  const document = toDocument(row!);
  const record = { recordTable: DOCUMENT_TABLE, recordId: document.documentId } as const;
  const facts = { kind: document.kind, version: document.version };
  await audit(tx, { action: 'consent_document.published', zone: 'clinical', ...record, details: facts });
  await emitEvent(tx, { type: 'consent_document.published', ...record, payload: facts });
  return document;
}

/** The patient's position on every kind of consent. Audited as one read of their consents. */
export async function consentStates(tx: TenantTx, patientId: string): Promise<ConsentState[]> {
  const tenantId = tx.context.tenantId;
  const current = await currentDocuments(tx);
  const decisions = await tx.db
    .select({ kind: patientConsents.kind, decision: patientConsents.decision, version: consentDocuments.version })
    .from(patientConsents)
    .innerJoin(consentDocuments, and(eq(consentDocuments.tenantId, patientConsents.tenantId), eq(consentDocuments.id, patientConsents.documentId)))
    .where(and(eq(patientConsents.tenantId, tenantId), eq(patientConsents.patientId, patientId)))
    .orderBy(desc(patientConsents.at), desc(patientConsents.id));
  await audit(tx, { action: 'patient_consent.read', zone: 'clinical', recordTable: CONSENT_TABLE, recordId: patientId });
  return CONSENT_KINDS.map((kind) => {
    const latest = decisions.find((row) => row.kind === kind);
    const document = current.get(kind) ?? null;
    const needed = !(document && latest?.decision === 'given' && latest.version === document.version);
    return { kind, document, decision: (latest?.decision as ConsentDecision | undefined) ?? null, decidedVersion: latest?.version ?? null, needed };
  });
}

/** The kinds a purpose still needs from this patient. */
export async function consentsNeeded(tx: TenantTx, patientId: string, purpose: ConsentPurpose): Promise<ConsentKind[]> {
  const wanted: readonly ConsentKind[] = CONSENTS_FOR[purpose];
  return (await consentStates(tx, patientId)).filter((state) => state.needed && wanted.includes(state.kind)).map((state) => state.kind);
}

/**
 * Refuse the action until the patient has given every consent it needs at
 * its current version (IDN13). Other modules call this before starting an
 * intake, booking a consult or ordering, through the front door.
 */
export async function assertConsents(tx: TenantTx, patientId: string, purpose: ConsentPurpose): Promise<void> {
  const needed = await consentsNeeded(tx, patientId, purpose);
  if (needed.length > 0) throw new AppError(409, 'consent_needed', 'Read and agree to the latest terms to carry on', { kinds: needed });
}

export interface ConsentDecisionInput {
  documentId: string;
  decision: ConsentDecision;
  channel: ConsentChannel;
  /** The staff member recording it for the patient, with their reason. */
  recordedBy?: { userId: string; reason: string };
}

/**
 * Record a decision against one exact version. Only the current version of a
 * kind can be given; a decision the same as the latest one adds nothing.
 */
export async function recordConsent(tx: TenantTx, patientId: string, input: ConsentDecisionInput): Promise<ConsentState[]> {
  const tenantId = tx.context.tenantId;
  const [patient] = await tx.db.select({ id: patients.id }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId))).for('update');
  if (!patient) throw new NotFoundError('Patient');
  const [document] = await tx.db.select(documentColumns).from(consentDocuments).where(and(eq(consentDocuments.tenantId, tenantId), eq(consentDocuments.id, input.documentId)));
  if (!document) throw new NotFoundError('Consent document');
  const kind = document.kind as ConsentKind;
  const current = (await currentDocuments(tx)).get(kind);
  if (input.decision === 'given' && current?.documentId !== document.documentId) {
    throw new BusinessRuleError('There is a newer version of this. Read it and agree to that one.', 'not_current_version');
  }
  if (!input.recordedBy && input.channel !== 'web') throw new BadRequestError('Only staff record a consent by phone or in person');

  const [latest] = await tx.db
    .select({ decision: patientConsents.decision, documentId: patientConsents.documentId })
    .from(patientConsents)
    .where(and(eq(patientConsents.tenantId, tenantId), eq(patientConsents.patientId, patientId), eq(patientConsents.kind, kind)))
    .orderBy(desc(patientConsents.at), desc(patientConsents.id))
    .limit(1);
  const unchanged = latest?.decision === input.decision && (input.decision === 'withdrawn' || latest.documentId === document.documentId);
  if (!unchanged) {
    if (input.decision === 'withdrawn' && latest?.decision !== 'given') throw new BusinessRuleError('There is no consent to withdraw', 'nothing_to_withdraw');
    const [row] = await tx.db
      .insert(patientConsents)
      .values({
        tenantId,
        patientId,
        documentId: document.documentId,
        kind,
        decision: input.decision,
        channel: input.channel,
        recordedBy: input.recordedBy?.userId ?? null,
        reason: input.recordedBy?.reason ?? null,
      })
      .returning({ id: patientConsents.id });
    const facts = { kind, version: document.version, channel: input.channel };
    const action = input.decision === 'given' ? 'consent.given' : 'consent.withdrawn';
    await audit(tx, { action, zone: 'clinical', recordTable: CONSENT_TABLE, recordId: row!.id, details: { ...facts, patientId } });
    await emitEvent(tx, { type: action, recordTable: CONSENT_TABLE, recordId: row!.id, payload: { ...facts, patientId } });
  }
  return consentStates(tx, patientId);
}

/** The tenant's current published version of one kind, or null when it has none. */
export async function currentConsentDocument(tx: TenantTx, kind: ConsentKind): Promise<ConsentDocument | null> {
  return (await currentDocuments(tx)).get(kind) ?? null;
}

/**
 * The consent a person gave on an intake's first screen, recorded as theirs
 * when they claim the intake (docs/decisions/intake.md INT6): that exact
 * version, at the time they gave it, so they aren't asked twice. A decision
 * already recorded on that version adds nothing; a later withdrawal stays
 * the latest decision.
 */
export async function recordIntakeConsent(tx: TenantTx, patientId: string, input: { documentId: string; at: Date }): Promise<void> {
  const tenantId = tx.context.tenantId;
  const [document] = await tx.db.select(documentColumns).from(consentDocuments).where(and(eq(consentDocuments.tenantId, tenantId), eq(consentDocuments.id, input.documentId)));
  if (!document) throw new NotFoundError('Consent document');
  const [already] = await tx.db
    .select({ id: patientConsents.id })
    .from(patientConsents)
    .where(and(eq(patientConsents.tenantId, tenantId), eq(patientConsents.patientId, patientId), eq(patientConsents.documentId, document.documentId), eq(patientConsents.decision, 'given')))
    .limit(1);
  if (already) return;
  const kind = document.kind as ConsentKind;
  const [row] = await tx.db
    .insert(patientConsents)
    .values({ tenantId, patientId, documentId: document.documentId, kind, decision: 'given', channel: 'web', at: input.at })
    .returning({ id: patientConsents.id });
  const facts = { kind, version: document.version, channel: 'web', patientId };
  await audit(tx, { action: 'consent.given', zone: 'clinical', recordTable: CONSENT_TABLE, recordId: row!.id, details: { ...facts, from: 'intake' } });
  await emitEvent(tx, { type: 'consent.given', recordTable: CONSENT_TABLE, recordId: row!.id, payload: facts });
}

/** The patient's latest "given" decision on one kind, with its document and time, or null. */
export async function givenConsentOf(tx: TenantTx, patientId: string, kind: ConsentKind): Promise<{ documentId: string; at: Date } | null> {
  const [latest] = await tx.db
    .select({ documentId: patientConsents.documentId, decision: patientConsents.decision, at: patientConsents.at })
    .from(patientConsents)
    .where(and(eq(patientConsents.tenantId, tx.context.tenantId), eq(patientConsents.patientId, patientId), eq(patientConsents.kind, kind)))
    .orderBy(desc(patientConsents.at), desc(patientConsents.id))
    .limit(1);
  return latest?.decision === 'given' ? { documentId: latest.documentId, at: latest.at } : null;
}
