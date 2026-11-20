import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { adherenceFlags, users } from '../../db/schema/index.js';
import type { FlagKind, FlagOutcome, FlagStatus, FlagUrgency } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { brokenConstraint } from '../../lib/database-errors.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { findPatients } from '../patients/index.js';
import { urgencyOrder } from './flags.service.js';

/**
 * The care team's side of adherence flags (docs/decisions/adherence.md ADH7,
 * ADH9 to ADH11): the list, one flag with its resolution, resolving and
 * reopening. Only people resolve or reopen (ADH8), and the note a resolver
 * writes is clinical text: never in an audit detail or event.
 */

const RECORD = 'clinical.adherence_flags';

export interface Resolution {
  outcome: FlagOutcome;
  resolvedAt: string;
  resolvedBy: { userId: string; displayName: string | null };
}

export interface AdherenceFlagSummary {
  adherenceFlagId: string;
  patientId: string;
  patientName: string;
  kind: FlagKind;
  urgency: FlagUrgency;
  status: FlagStatus;
  raisedAt: string;
  sideEffectId: string | null;
  reopenedFromId: string | null;
  resolution: Resolution | null;
}

export interface AdherenceFlagDetail extends AdherenceFlagSummary {
  resolution: (Resolution & { note: string | null }) | null;
  /** The earlier resolution this flag reopens, so the sheet shows what was done before. */
  reopenedFrom: (Resolution & { note: string | null }) | null;
  /** The flag that reopened this one, if any: a flag is reopened once at most (ADH7). */
  reopenedAsId: string | null;
}

const columns = {
  id: adherenceFlags.id,
  patientId: adherenceFlags.patientId,
  kind: adherenceFlags.kind,
  urgency: adherenceFlags.urgency,
  status: adherenceFlags.status,
  raisedAt: adherenceFlags.raisedAt,
  sideEffectId: adherenceFlags.sideEffectId,
  reopenedFromId: adherenceFlags.reopenedFromId,
  resolvedAt: adherenceFlags.resolvedAt,
  resolvedBy: adherenceFlags.resolvedBy,
  outcome: adherenceFlags.outcome,
  note: adherenceFlags.note,
  resolverName: users.displayName,
};

interface Row {
  id: string;
  patientId: string;
  kind: string;
  urgency: string;
  status: string;
  raisedAt: Date;
  sideEffectId: string | null;
  reopenedFromId: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  outcome: string | null;
  note: string | null;
  resolverName: string | null;
}

function resolutionOf(row: Row): (Resolution & { note: string | null }) | null {
  if (!row.resolvedAt || !row.resolvedBy || !row.outcome) return null;
  return { outcome: row.outcome as FlagOutcome, resolvedAt: row.resolvedAt.toISOString(), resolvedBy: { userId: row.resolvedBy, displayName: row.resolverName }, note: row.note };
}

function summaryOf(row: Row, patientName: string): AdherenceFlagSummary {
  const resolution = resolutionOf(row);
  return {
    adherenceFlagId: row.id,
    patientId: row.patientId,
    patientName,
    kind: row.kind as FlagKind,
    urgency: row.urgency as FlagUrgency,
    status: row.status as FlagStatus,
    raisedAt: row.raisedAt.toISOString(),
    sideEffectId: row.sideEffectId,
    reopenedFromId: row.reopenedFromId,
    resolution: resolution && { outcome: resolution.outcome, resolvedAt: resolution.resolvedAt, resolvedBy: resolution.resolvedBy },
  };
}

function selectFlags(tx: TenantTx) {
  return tx.db.select(columns).from(adherenceFlags).leftJoin(users, eq(users.id, adherenceFlags.resolvedBy));
}

async function oneFlag(tx: TenantTx, adherenceFlagId: string): Promise<Row | null> {
  const [row] = await selectFlags(tx).where(and(eq(adherenceFlags.tenantId, tx.context.tenantId), eq(adherenceFlags.id, adherenceFlagId)));
  return row ?? null;
}

/** Only a person reads a resolver's note or changes a flag; an agent never does (ADH8). */
function requirePerson(tx: TenantTx): string {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person on the care team does this');
  return tx.context.actor.userId;
}

/**
 * The list (ADH9): open flags urgent first, then oldest first; resolved ones
 * newest resolution first. One audit entry for the list with the count; the
 * patients' names are read through the patients module, which audits them.
 */
export async function listAdherenceFlags(tx: TenantTx, query: { status: FlagStatus; limit: number }): Promise<AdherenceFlagSummary[]> {
  const order = query.status === 'open' ? [urgencyOrder(), asc(adherenceFlags.raisedAt)] : [desc(adherenceFlags.resolvedAt)];
  const rows: Row[] = await selectFlags(tx)
    .where(and(eq(adherenceFlags.tenantId, tx.context.tenantId), eq(adherenceFlags.status, query.status)))
    .orderBy(...order)
    .limit(query.limit);
  await audit(tx, { action: 'adherence_flag.listed', zone: 'clinical', recordTable: RECORD, recordId: '*', details: { status: query.status, count: rows.length } });
  const patients = await findPatients(tx, rows.map((row) => row.patientId));
  return rows.map((row) => summaryOf(row, patients.get(row.patientId)?.displayName ?? ''));
}

/** One flag, with its note, the resolution it reopens and the flag that reopened it (ADH10). An audited read of the patient's record. */
export async function getAdherenceFlag(tx: TenantTx, adherenceFlagId: string): Promise<AdherenceFlagDetail> {
  requirePerson(tx);
  const row = await oneFlag(tx, adherenceFlagId);
  if (!row) throw new NotFoundError('Adherence flag');
  const earlier = row.reopenedFromId ? await oneFlag(tx, row.reopenedFromId) : null;
  const [later] = await tx.db
    .select({ id: adherenceFlags.id })
    .from(adherenceFlags)
    .where(and(eq(adherenceFlags.tenantId, tx.context.tenantId), eq(adherenceFlags.reopenedFromId, row.id)));
  await audit(tx, { action: 'adherence_flag.read', zone: 'clinical', recordTable: RECORD, recordId: row.id, details: { patientId: row.patientId } });
  const patient = (await findPatients(tx, [row.patientId])).get(row.patientId);
  return {
    ...summaryOf(row, patient?.displayName ?? ''),
    resolution: resolutionOf(row),
    reopenedFrom: earlier ? resolutionOf(earlier) : null,
    reopenedAsId: later?.id ?? null,
  };
}

/** Resolve an open flag with what was done (ADH7). A resolved flag is never resolved again. */
export async function resolveAdherenceFlag(tx: TenantTx, adherenceFlagId: string, input: { outcome: FlagOutcome; note?: string | null | undefined }): Promise<AdherenceFlagDetail> {
  const userId = requirePerson(tx);
  const note = input.note?.trim() || null;
  const [row] = await tx.db
    .update(adherenceFlags)
    .set({ status: 'resolved', resolvedAt: sql`now()`, resolvedBy: userId, outcome: input.outcome, note })
    .where(and(eq(adherenceFlags.tenantId, tx.context.tenantId), eq(adherenceFlags.id, adherenceFlagId), eq(adherenceFlags.status, 'open')))
    .returning({ id: adherenceFlags.id, patientId: adherenceFlags.patientId, kind: adherenceFlags.kind });
  if (!row) {
    if (await oneFlag(tx, adherenceFlagId)) throw new BusinessRuleError('This adherence flag is already resolved', 'already_resolved');
    throw new NotFoundError('Adherence flag');
  }
  const facts = { patientId: row.patientId, kind: row.kind, outcome: input.outcome, withNote: note !== null };
  await audit(tx, { action: 'adherence_flag.resolved', zone: 'clinical', recordTable: RECORD, recordId: row.id, details: facts });
  await emitEvent(tx, { type: 'adherence_flag.resolved', recordTable: RECORD, recordId: row.id, payload: { patientId: row.patientId, kind: row.kind, outcome: input.outcome } });
  return getAdherenceFlag(tx, row.id);
}

/**
 * Undo a mistaken resolution (ADH7): a new open flag for the same cause and
 * urgency, linked to the resolved one, which is left as it was. A flag is
 * reopened once at most; after that, its reopening is the one to act on.
 */
export async function reopenAdherenceFlag(tx: TenantTx, adherenceFlagId: string): Promise<AdherenceFlagDetail> {
  requirePerson(tx);
  const earlier = await oneFlag(tx, adherenceFlagId);
  if (!earlier) throw new NotFoundError('Adherence flag');
  if (earlier.status !== 'resolved') throw new BusinessRuleError('Only a resolved adherence flag can be reopened', 'not_resolved');
  const inserted = await tx.db
    .insert(adherenceFlags)
    .values({ tenantId: tx.context.tenantId, patientId: earlier.patientId, kind: earlier.kind, urgency: earlier.urgency, sideEffectId: earlier.sideEffectId, reopenedFromId: earlier.id })
    .returning({ id: adherenceFlags.id })
    .catch((error: unknown) => {
      if (brokenConstraint(error) === 'adherence_flags_reopened_from_key') throw new BusinessRuleError('This adherence flag was reopened already', 'already_reopened');
      throw error;
    });
  const reopened = inserted[0]!;
  const facts = { patientId: earlier.patientId, kind: earlier.kind, urgency: earlier.urgency, reopenedFromId: earlier.id };
  await audit(tx, { action: 'adherence_flag.reopened', zone: 'clinical', recordTable: RECORD, recordId: reopened.id, details: facts });
  await emitEvent(tx, { type: 'adherence_flag.reopened', recordTable: RECORD, recordId: reopened.id, payload: facts });
  return getAdherenceFlag(tx, reopened.id);
}
