import { z } from 'zod';
import { MEASUREMENT_KINDS, MISSED_DOSES, SIDE_EFFECT_SEVERITIES } from '../../db/schema/values.js';

/** Request and reply shapes for measurements, side effects and check-ins (ADR 0014). Field names follow GLOSSARY.md. */

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const measurementKindSchema = z.enum(MEASUREMENT_KINDS);

export const readingBody = z.object({ kind: measurementKindSchema, value: z.number().positive().max(9999) }).strict();
export type ReadingInput = z.infer<typeof readingBody>;

const readings = z.array(readingBody).min(1).max(MEASUREMENT_KINDS.length);

export const measurementsBody = z
  .object({
    readings,
    /** When the readings were taken; now when left out (TRK2). */
    measuredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const measurementsQuery = z.object({ kind: measurementKindSchema.optional() }).strict();

export const measurement = z.object({
  measurementId: z.uuid(),
  kind: measurementKindSchema,
  value: z.number(),
  /** The kind's one unit (TRK1). */
  unit: z.enum(['kg', 'cm', 'mmHg', 'bpm']),
  measuredAt: z.iso.datetime({ offset: true }),
  /** Whether the patient or their care team recorded it. */
  recordedBy: z.enum(['patient', 'care_team']),
  checkInId: z.uuid().nullable(),
});
export type Measurement = z.infer<typeof measurement>;
export const measurementsReply = z.object({ measurements: z.array(measurement) });

export const sideEffectBody = z
  .object({
    severity: z.enum(SIDE_EFFECT_SEVERITIES),
    description: z.string().trim().min(1).max(2000),
    startedOn: calendarDate.nullable().optional(),
  })
  .strict();
export type SideEffectInput = z.infer<typeof sideEffectBody>;

export const sideEffect = z.object({
  sideEffectId: z.uuid(),
  severity: z.enum(SIDE_EFFECT_SEVERITIES),
  description: z.string(),
  startedOn: z.string().nullable(),
  reportedAt: z.iso.datetime({ offset: true }),
  reportedBy: z.enum(['patient', 'care_team']),
  checkInId: z.uuid().nullable(),
});
export type SideEffect = z.infer<typeof sideEffect>;
export const sideEffectsReply = z.object({ sideEffects: z.array(sideEffect) });
export const sideEffectParams = z.object({ sideEffectId: z.uuid() }).strict();
export const careTeamSideEffect = sideEffect.extend({ patientId: z.uuid() });

export const checkInBody = z
  .object({
    missedDoses: z.enum(MISSED_DOSES),
    feeling: z.number().int().min(1).max(5),
    readings: readings.optional(),
    sideEffect: sideEffectBody.nullable().optional(),
  })
  .strict();
export type CheckInInput = z.infer<typeof checkInBody>;

export const checkIn = z.object({
  checkInId: z.uuid(),
  missedDoses: z.enum(MISSED_DOSES),
  feeling: z.number().int(),
  submittedAt: z.iso.datetime({ offset: true }),
  measurements: z.array(measurement),
  sideEffect: sideEffect.nullable(),
});
export type CheckIn = z.infer<typeof checkIn>;
export const checkInsReply = z.object({ checkIns: z.array(checkIn) });
