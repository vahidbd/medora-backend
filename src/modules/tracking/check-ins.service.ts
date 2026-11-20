import { and, desc, eq } from 'drizzle-orm';
import { checkIns } from '../../db/schema/index.js';
import type { MissedDoses } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { recordActivity } from '../adherence/index.js';
import { checkReadings, measurementsOfCheckIns, recordMeasurements } from './measurements.service.js';
import { checkStartedOn, reportSideEffect, sideEffectsOfCheckIns } from './side-effects.service.js';
import type { CheckIn, CheckInInput } from './tracking.schemas.js';

/**
 * Check-ins (docs/decisions/tracking.md TRK5): the patient's answer to "how
 * is it going?" between consults: missed doses, how they feel, and the
 * readings and side effect they add. One transaction, so a check-in is
 * never half written.
 */

const RECORD = 'clinical.check_ins';
const LIST_LIMIT = 52;

export async function submitCheckIn(tx: TenantTx, patientId: string, input: CheckInInput): Promise<CheckIn> {
  // Everything is checked before anything is written.
  const now = new Date();
  if (input.readings) checkReadings(input.readings, now, now);
  if (input.sideEffect) checkStartedOn(input.sideEffect.startedOn, now);

  const [row] = await tx.db
    .insert(checkIns)
    .values({ tenantId: tx.context.tenantId, patientId, missedDoses: input.missedDoses, feeling: input.feeling, submittedAt: now })
    .returning();
  const submitted = row!;
  const facts = { patientId, missedDoses: submitted.missedDoses, feeling: submitted.feeling };
  await audit(tx, { action: 'check_in.submitted', zone: 'clinical', recordTable: RECORD, recordId: submitted.id, details: facts });
  await emitEvent(tx, { type: 'check_in.submitted', recordTable: RECORD, recordId: submitted.id, payload: facts });
  await recordActivity(tx, { patientId, kind: 'check_in_submitted', source: { table: RECORD, id: submitted.id } });

  const readings = input.readings ? await recordMeasurements(tx, { patientId, readings: input.readings, measuredAt: now, checkInId: submitted.id }) : [];
  const sideEffect = input.sideEffect ? await reportSideEffect(tx, { patientId, checkInId: submitted.id, ...input.sideEffect }) : null;
  return {
    checkInId: submitted.id,
    missedDoses: submitted.missedDoses as MissedDoses,
    feeling: submitted.feeling,
    submittedAt: submitted.submittedAt.toISOString(),
    measurements: readings,
    sideEffect,
  };
}

/** A patient's check-ins, newest first, each with what came with it. */
export async function checkInsOf(tx: TenantTx, patientId: string): Promise<CheckIn[]> {
  const rows = await tx.db
    .select()
    .from(checkIns)
    .where(and(eq(checkIns.tenantId, tx.context.tenantId), eq(checkIns.patientId, patientId)))
    .orderBy(desc(checkIns.submittedAt))
    .limit(LIST_LIMIT);
  const ids = rows.map((r) => r.id);
  const [readings, effects] = [await measurementsOfCheckIns(tx, ids), await sideEffectsOfCheckIns(tx, ids)];
  await audit(tx, { action: 'check_in.read', zone: 'clinical', recordTable: 'clinical.patients', recordId: patientId, details: { count: rows.length } });
  return rows.map((r) => ({
    checkInId: r.id,
    missedDoses: r.missedDoses as MissedDoses,
    feeling: r.feeling,
    submittedAt: r.submittedAt.toISOString(),
    measurements: readings.get(r.id) ?? [],
    sideEffect: effects.get(r.id) ?? null,
  }));
}
