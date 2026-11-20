import { and, desc, eq, inArray } from 'drizzle-orm';
import { sideEffects } from '../../db/schema/index.js';
import type { SideEffectSeverity } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { localDate } from '../../lib/time.js';
import { flagSideEffect, recordActivity } from '../adherence/index.js';
import { recordedByOf, recorderOf } from './recorder.js';
import type { SideEffect, SideEffectInput } from './tracking.schemas.js';

/**
 * Side effects (docs/decisions/tracking.md TRK4): the patient's words and how
 * bad it is. A report is clinical text, so it never goes into an audit
 * detail or an event: those carry the id and the severity only. A severe
 * report is the care team's to act on first: its adherence flag is raised in
 * the same transaction (ADR 0260), and `side_effect.reported` tells whoever
 * else reacts (governance's adverse events).
 */

const RECORD = 'clinical.side_effects';
const LIST_LIMIT = 200;
/** The day on the earth's earliest clock: a start date after it is in the future everywhere. */
const EARLIEST_ZONE = 'Pacific/Kiritimati';
const OLDEST_START_DAYS = 2 * 366;

type Row = typeof sideEffects.$inferSelect;

function toSideEffect(row: Row): SideEffect {
  return {
    sideEffectId: row.id,
    severity: row.severity as SideEffectSeverity,
    description: row.description,
    startedOn: row.startedOn,
    reportedAt: row.reportedAt.toISOString(),
    reportedBy: recordedByOf(row.reportedByType),
    checkInId: row.checkInId,
  };
}

export function checkStartedOn(startedOn: string | null | undefined, now = new Date()): void {
  if (!startedOn) return;
  const parsed = new Date(`${startedOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || localDate(parsed, 'UTC') !== startedOn) throw new BadRequestError('That date is not real', 'started_on');
  if (startedOn > localDate(now, EARLIEST_ZONE)) throw new BadRequestError("The start date can't be in the future", 'started_on');
  if (now.getTime() - parsed.getTime() > OLDEST_START_DAYS * 86_400_000) throw new BadRequestError('That start date is too long ago', 'started_on');
}

export async function reportSideEffect(tx: TenantTx, input: { patientId: string; checkInId?: string | null } & SideEffectInput): Promise<SideEffect> {
  checkStartedOn(input.startedOn);
  const recorder = recorderOf(tx);
  const [row] = await tx.db
    .insert(sideEffects)
    .values({
      tenantId: tx.context.tenantId,
      patientId: input.patientId,
      severity: input.severity,
      description: input.description.trim(),
      startedOn: input.startedOn ?? null,
      reportedByType: recorder.type,
      reportedById: recorder.id,
      checkInId: input.checkInId ?? null,
    })
    .returning();
  const reported = row!;
  const facts = { patientId: input.patientId, severity: reported.severity };
  await audit(tx, { action: 'side_effect.reported', zone: 'clinical', recordTable: RECORD, recordId: reported.id, details: facts });
  await emitEvent(tx, { type: 'side_effect.reported', recordTable: RECORD, recordId: reported.id, payload: facts });
  // Written with the report, so a severe one can't exist without its flag (ADR 0260, docs/decisions/adherence.md ADH4).
  await flagSideEffect(tx, { patientId: input.patientId, sideEffectId: reported.id, severity: input.severity });
  await recordActivity(tx, { patientId: input.patientId, kind: 'side_effect_reported', source: { table: RECORD, id: reported.id } });
  return toSideEffect(reported);
}

export async function sideEffectsOf(tx: TenantTx, patientId: string): Promise<SideEffect[]> {
  const rows = await tx.db
    .select()
    .from(sideEffects)
    .where(and(eq(sideEffects.tenantId, tx.context.tenantId), eq(sideEffects.patientId, patientId)))
    .orderBy(desc(sideEffects.reportedAt))
    .limit(LIST_LIMIT);
  await audit(tx, { action: 'side_effect.read', zone: 'clinical', recordTable: 'clinical.patients', recordId: patientId, details: { count: rows.length } });
  return rows.map(toSideEffect);
}

/** The side effects reported in some check-ins, by check-in. Audited by the caller's read. */
export async function sideEffectsOfCheckIns(tx: TenantTx, checkInIds: readonly string[]): Promise<Map<string, SideEffect>> {
  const byCheckIn = new Map<string, SideEffect>();
  if (checkInIds.length === 0) return byCheckIn;
  const rows = await tx.db
    .select()
    .from(sideEffects)
    .where(and(eq(sideEffects.tenantId, tx.context.tenantId), inArray(sideEffects.checkInId, [...checkInIds])));
  for (const row of rows) if (row.checkInId) byCheckIn.set(row.checkInId, toSideEffect(row));
  return byCheckIn;
}

/**
 * One report, for the care team acting on the adherence flag it raised
 * (docs/decisions/adherence.md ADH10). The patient's words: a person reads
 * them, never an agent, and the read is audited.
 */
export async function sideEffectForCareTeam(tx: TenantTx, sideEffectId: string): Promise<SideEffect & { patientId: string }> {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person on the care team reads this');
  const [row] = await tx.db.select().from(sideEffects).where(and(eq(sideEffects.tenantId, tx.context.tenantId), eq(sideEffects.id, sideEffectId)));
  if (!row) throw new NotFoundError('Side effect');
  await audit(tx, { action: 'side_effect.read', zone: 'clinical', recordTable: RECORD, recordId: row.id, details: { patientId: row.patientId } });
  return { ...toSideEffect(row), patientId: row.patientId };
}
