import { and, desc, eq, inArray } from 'drizzle-orm';
import { measurements } from '../../db/schema/index.js';
import type { MeasurementKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { Measurement, ReadingInput } from './tracking.schemas.js';
import { recorderOf, recordedByOf } from './recorder.js';

/**
 * Measurements (docs/decisions/tracking.md TRK1 to TRK3): one table for every
 * kind, each in one unit, written by the patient or their care team and
 * never changed. Every read and write is audited against the patient.
 */

/** Each kind's unit, and the range a real reading falls in; anything outside is a typing slip (TRK1). */
export const KINDS: Record<MeasurementKind, { unit: Measurement['unit']; min: number; max: number }> = {
  weight: { unit: 'kg', min: 20, max: 400 },
  waist: { unit: 'cm', min: 30, max: 300 },
  height: { unit: 'cm', min: 50, max: 250 },
  blood_pressure_systolic: { unit: 'mmHg', min: 50, max: 260 },
  blood_pressure_diastolic: { unit: 'mmHg', min: 30, max: 160 },
  heart_rate: { unit: 'bpm', min: 25, max: 250 },
};

/** How far back a reading may be dated (TRK2). */
const BACKDATE_DAYS = 30;
/** Clock drift allowed on a reading dated "now". */
const AHEAD_MS = 5 * 60_000;
const LIST_LIMIT = 500;

const RECORD = 'clinical.measurements';

type Row = typeof measurements.$inferSelect;

function toMeasurement(row: Row): Measurement {
  return {
    measurementId: row.id,
    kind: row.kind as MeasurementKind,
    value: Number(row.value),
    unit: KINDS[row.kind as MeasurementKind].unit,
    measuredAt: row.measuredAt.toISOString(),
    recordedBy: recordedByOf(row.recordedByType),
    checkInId: row.checkInId,
  };
}

/** The checks every set of readings passes before any is written. */
export function checkReadings(readings: readonly ReadingInput[], measuredAt: Date, now = new Date()): void {
  const kinds = readings.map((reading) => reading.kind);
  if (new Set(kinds).size !== kinds.length) throw new BadRequestError('Send each kind of measurement once', 'duplicate_kind');
  for (const reading of readings) {
    const { min, max, unit } = KINDS[reading.kind];
    if (reading.value < min || reading.value > max) {
      throw new BadRequestError(`That ${reading.kind.replace(/_/g, ' ')} doesn't look right: enter it in ${unit}`, 'out_of_range');
    }
  }
  const systolic = readings.find((r) => r.kind === 'blood_pressure_systolic');
  const diastolic = readings.find((r) => r.kind === 'blood_pressure_diastolic');
  if (Boolean(systolic) !== Boolean(diastolic)) throw new BadRequestError('Blood pressure needs both numbers', 'blood_pressure_pair');
  if (systolic && diastolic && systolic.value <= diastolic.value) {
    throw new BadRequestError('The first blood pressure number is the higher one', 'blood_pressure_order');
  }
  if (measuredAt.getTime() > now.getTime() + AHEAD_MS) throw new BadRequestError("A reading can't be in the future", 'measured_in_future');
  if (measuredAt.getTime() < now.getTime() - BACKDATE_DAYS * 86_400_000) {
    throw new BadRequestError(`A reading can be at most ${BACKDATE_DAYS} days old`, 'measured_too_long_ago');
  }
}

/** Writes readings taken together, after checkReadings. The caller's actor is who recorded them. */
export async function recordMeasurements(
  tx: TenantTx,
  input: { patientId: string; readings: readonly ReadingInput[]; measuredAt?: Date; checkInId?: string | null },
): Promise<Measurement[]> {
  const measuredAt = input.measuredAt ?? new Date();
  checkReadings(input.readings, measuredAt);
  const recorder = recorderOf(tx);
  const rows = await tx.db
    .insert(measurements)
    .values(
      input.readings.map((reading) => ({
        tenantId: tx.context.tenantId,
        patientId: input.patientId,
        kind: reading.kind,
        value: reading.value,
        measuredAt,
        recordedByType: recorder.type,
        recordedById: recorder.id,
        checkInId: input.checkInId ?? null,
      })),
    )
    .returning();
  for (const row of rows) {
    await audit(tx, { action: 'measurement.recorded', zone: 'clinical', recordTable: RECORD, recordId: row.id, details: { patientId: input.patientId, kind: row.kind } });
    await emitEvent(tx, { type: 'measurement.recorded', recordTable: RECORD, recordId: row.id, payload: { patientId: input.patientId, kind: row.kind } });
  }
  return rows.map(toMeasurement);
}

/** A patient's measurements, newest first: one kind, or every kind (for the chart). */
export async function measurementsOf(tx: TenantTx, patientId: string, kind?: MeasurementKind): Promise<Measurement[]> {
  const rows = await tx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.tenantId, tx.context.tenantId), eq(measurements.patientId, patientId), kind ? eq(measurements.kind, kind) : undefined))
    .orderBy(desc(measurements.measuredAt), desc(measurements.createdAt))
    .limit(LIST_LIMIT);
  await audit(tx, { action: 'measurement.read', zone: 'clinical', recordTable: 'clinical.patients', recordId: patientId, details: { kind: kind ?? null, count: rows.length } });
  return rows.map(toMeasurement);
}

/** The readings that came with some check-ins, by check-in. Audited by the caller's read. */
export async function measurementsOfCheckIns(tx: TenantTx, checkInIds: readonly string[]): Promise<Map<string, Measurement[]>> {
  const byCheckIn = new Map<string, Measurement[]>();
  if (checkInIds.length === 0) return byCheckIn;
  const rows = await tx.db
    .select()
    .from(measurements)
    .where(and(eq(measurements.tenantId, tx.context.tenantId), inArray(measurements.checkInId, [...checkInIds])));
  for (const row of rows) {
    if (!row.checkInId) continue;
    byCheckIn.set(row.checkInId, [...(byCheckIn.get(row.checkInId) ?? []), toMeasurement(row)]);
  }
  return byCheckIn;
}
