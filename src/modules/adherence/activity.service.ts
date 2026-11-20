import { and, desc, eq } from 'drizzle-orm';
import { adherenceActivity } from '../../db/schema/index.js';
import type { ActivityKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { localDate } from '../../lib/time.js';
import { findPatientContact } from '../patients/index.js';

/**
 * The adherence activity stream (docs/decisions/adherence.md ADH1, ADH2, ADR
 * 0260): what the patient did, written by the module that did it, in the same
 * transaction. Only the patient's own actions count: a reading a staff member
 * records for them is not the patient keeping up. Rows are never changed.
 */

const RECORD = 'clinical.adherence_activity';
const LIST_LIMIT = 200;

/** The record an action wrote, so the stream can point at it. */
export interface ActivitySource {
  table: `${string}.${string}`;
  id: string;
}

export interface Activity {
  activityId: string;
  kind: ActivityKind;
  occurredAt: string;
  source: ActivitySource | null;
}

type Row = typeof adherenceActivity.$inferSelect;

function toActivity(row: Row): Activity {
  return {
    activityId: row.id,
    kind: row.kind as ActivityKind,
    occurredAt: row.occurredAt.toISOString(),
    source: row.sourceTable && row.sourceId ? { table: row.sourceTable as ActivitySource['table'], id: row.sourceId } : null,
  };
}

/** Whether the transaction's actor is this patient, on their own record. */
function isThePatient(tx: TenantTx, patientId: string): boolean {
  return tx.context.actor.type === 'patient' && tx.context.actor.patientId === patientId;
}

async function auditRecorded(tx: TenantTx, row: Row): Promise<void> {
  await audit(tx, { action: 'adherence_activity.recorded', zone: 'clinical', recordTable: RECORD, recordId: row.id, details: { patientId: row.patientId, kind: row.kind } });
}

/**
 * Adds one action to the patient's stream, when the patient did it (ADH1).
 * Call it in the same transaction as the action. Anyone else acting for the
 * patient writes nothing, and null comes back. `app_opened` goes through
 * recordAppOpened, which keeps it to once a day.
 */
export async function recordActivity(
  tx: TenantTx,
  input: { patientId: string; kind: Exclude<ActivityKind, 'app_opened'>; source: ActivitySource | null },
): Promise<Activity | null> {
  if (!isThePatient(tx, input.patientId)) return null;
  const [row] = await tx.db
    .insert(adherenceActivity)
    .values({ tenantId: tx.context.tenantId, patientId: input.patientId, kind: input.kind, sourceTable: input.source?.table ?? null, sourceId: input.source?.id ?? null })
    .returning();
  await auditRecorded(tx, row!);
  return toActivity(row!);
}

/**
 * The patient opened their app (ADH2): at most once on each of their calendar
 * days, in their time zone, else the tenant's (ADR 0017). The unique index
 * holds it, so two tabs loading together still write one row.
 */
export async function recordAppOpened(tx: TenantTx, patientId: string, now = new Date()): Promise<{ openedOn: string }> {
  if (!isThePatient(tx, patientId)) throw new NotFoundError('Patient');
  const patient = await findPatientContact(tx, patientId);
  if (!patient) throw new NotFoundError('Patient');
  const openedOn = localDate(now, patient.timeZone);
  const [row] = await tx.db
    .insert(adherenceActivity)
    .values({ tenantId: tx.context.tenantId, patientId, kind: 'app_opened', occurredAt: now, openedOn })
    .onConflictDoNothing()
    .returning();
  if (row) await auditRecorded(tx, row);
  return { openedOn };
}

/** A patient's stream, newest first, for the care team and the rules. Audited as one read of the patient's record. */
export async function activityOf(tx: TenantTx, patientId: string): Promise<Activity[]> {
  const rows = await tx.db
    .select()
    .from(adherenceActivity)
    .where(and(eq(adherenceActivity.tenantId, tx.context.tenantId), eq(adherenceActivity.patientId, patientId)))
    .orderBy(desc(adherenceActivity.occurredAt))
    .limit(LIST_LIMIT);
  await audit(tx, { action: 'adherence_activity.read', zone: 'clinical', recordTable: 'clinical.patients', recordId: patientId, details: { count: rows.length } });
  return rows.map(toActivity);
}
