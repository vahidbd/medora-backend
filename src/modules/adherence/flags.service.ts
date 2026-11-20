import { and, asc, eq, sql } from 'drizzle-orm';
import { adherenceFlags } from '../../db/schema/index.js';
import type { FlagKind, FlagUrgency, SideEffectSeverity } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';

/**
 * Raising adherence flags (docs/decisions/adherence.md ADH3 to ADH6, ADR
 * 0260): a rule spots a risk and the care team is shown it. A flag is
 * written in the same transaction as what caused it, never later by event
 * delivery, so the cause can't exist without its flag. Audit details and
 * events carry ids, the kind and the urgency only.
 */

const RECORD = 'clinical.adherence_flags';

/** How soon a side effect report is looked at, by its severity (ADH5). Mild is activity only. */
export const SIDE_EFFECT_URGENCY: Record<SideEffectSeverity, FlagUrgency | null> = {
  severe: 'urgent',
  moderate: 'soon',
  mild: null,
};

/** What an agent may know of a patient's open flags: never the patient's words (ADH8). */
export interface OpenAdherenceFlag {
  adherenceFlagId: string;
  kind: FlagKind;
  urgency: FlagUrgency;
  raisedAt: string;
}

/**
 * A side effect was reported, by the patient or by staff for them (ADH4,
 * ADH5). Raises its flag when the severity calls for one; one flag per
 * report, so calling this twice for the same report changes nothing.
 * Returns the flag's id, or null when none was raised.
 */
export async function flagSideEffect(tx: TenantTx, input: { patientId: string; sideEffectId: string; severity: SideEffectSeverity }): Promise<string | null> {
  const urgency = SIDE_EFFECT_URGENCY[input.severity];
  if (!urgency) return null;
  const [row] = await tx.db
    .insert(adherenceFlags)
    .values({ tenantId: tx.context.tenantId, patientId: input.patientId, kind: 'side_effect_reported', urgency, sideEffectId: input.sideEffectId })
    .onConflictDoNothing({ target: [adherenceFlags.tenantId, adherenceFlags.sideEffectId], where: sql`${adherenceFlags.reopenedFromId} is null` })
    .returning({ id: adherenceFlags.id });
  if (!row) return null;
  const facts = { patientId: input.patientId, kind: 'side_effect_reported', urgency };
  await audit(tx, { action: 'adherence_flag.raised', zone: 'clinical', recordTable: RECORD, recordId: row.id, details: facts });
  await emitEvent(tx, { type: 'adherence_flag.raised', recordTable: RECORD, recordId: row.id, payload: facts });
  return row.id;
}

/**
 * A patient's open flags, urgent first then oldest, for the care coordinator
 * agent and anything else that must know without reading the patient's
 * words (ADH8). Audited as one read of the patient's record.
 */
export async function openFlagsOf(tx: TenantTx, patientId: string): Promise<OpenAdherenceFlag[]> {
  const rows = await tx.db
    .select({ id: adherenceFlags.id, kind: adherenceFlags.kind, urgency: adherenceFlags.urgency, raisedAt: adherenceFlags.raisedAt })
    .from(adherenceFlags)
    .where(and(eq(adherenceFlags.tenantId, tx.context.tenantId), eq(adherenceFlags.patientId, patientId), eq(adherenceFlags.status, 'open')))
    .orderBy(urgencyOrder(), asc(adherenceFlags.raisedAt));
  await audit(tx, { action: 'adherence_flag.read', zone: 'clinical', recordTable: 'clinical.patients', recordId: patientId, details: { count: rows.length } });
  return rows.map((row) => ({ adherenceFlagId: row.id, kind: row.kind as FlagKind, urgency: row.urgency as FlagUrgency, raisedAt: row.raisedAt.toISOString() }));
}

/** Urgent, then soon, then routine. */
export function urgencyOrder() {
  return sql`case ${adherenceFlags.urgency} when 'urgent' then 0 when 'soon' then 1 else 2 end`;
}
