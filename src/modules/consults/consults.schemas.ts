import { z } from 'zod';
import { CANCELLATION_REASONS, type CancellationReason, CONSULT_MODES, CONSULT_PURPOSES, CONSULT_STATUSES, type ConsultPurpose } from '../../db/schema/values.js';

/** Request and reply shapes for booking (docs/decisions/consults.md CNS11 to CNS16). Times are instants; screens choose the zone. */

const instant = z.iso.datetime({ offset: true });

export const consultParams = z.object({ consultId: z.uuid() });

export const scheduleQuery = z.object({
  from: instant,
  to: instant,
  clinicianUserId: z.uuid().optional(),
  patientId: z.uuid().optional(),
});

/** One clinician's slots, or with only a purpose, every eligible clinician's together (CNS18). */
export const slotsQuery = z.object({
  clinicianUserId: z.uuid().optional(),
  purpose: z.enum(CONSULT_PURPOSES).optional(),
  from: instant.optional(),
  to: instant.optional(),
});

/** One entry in the schedule: exactly these fields, never anything from the evidence or the consult's content (CNS11). */
export const scheduleEntry = z.object({
  consultId: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string(),
  clinicianUserId: z.uuid(),
  /** The brand it was booked through (CNS24). */
  brandId: z.uuid(),
  startsAt: instant,
  endsAt: instant,
  mode: z.enum(CONSULT_MODES),
  purpose: z.enum(CONSULT_PURPOSES),
  status: z.enum(CONSULT_STATUSES),
  cancellationReason: z.enum(CANCELLATION_REASONS).nullable(),
  rescheduledFrom: z.uuid().nullable(),
});
export type ScheduleEntry = z.infer<typeof scheduleEntry>;

export const scheduleReply = z.object({ consults: z.array(scheduleEntry) });

export const slotsReply = z.object({
  /** The clinician's zone, the one their hours are in, or the tenant's for pooled slots (ADR 0017). */
  timeZone: z.string(),
  slots: z.array(z.object({ startsAt: instant, endsAt: instant })),
});

export const bookBody = z.object({
  patientId: z.uuid(),
  /** The brand the patient is booked through; its messages come from it (CNS24). */
  brandId: z.uuid(),
  /** Left out, a clinician free then is assigned (CNS19). */
  clinicianUserId: z.uuid().optional(),
  mode: z.enum(CONSULT_MODES),
  purpose: z.enum(CONSULT_PURPOSES),
  startsAt: instant,
});
export type BookConsult = z.infer<typeof bookBody>;

export const rescheduleBody = z.object({
  startsAt: instant,
  /** Another clinician, if the consult moves to them. */
  clinicianUserId: z.uuid().optional(),
  mode: z.enum(CONSULT_MODES).optional(),
  /** The patient the caller means; another patient's consult is not found (CNS20). */
  patientId: z.uuid().optional(),
});
export type RescheduleConsult = z.infer<typeof rescheduleBody>;

/** `rescheduled` is set only by a move (CNS14), so it can't be chosen. */
export const CHOOSABLE_CANCELLATION_REASONS = ['patient_request', 'clinician_unavailable', 'booked_in_error', 'other'] as const satisfies readonly CancellationReason[];
export const cancelBody = z.object({ reason: z.enum(CHOOSABLE_CANCELLATION_REASONS), patientId: z.uuid().optional() });

/** What a patient books for themselves: a first consult or a review (CNS21). Follow-ups are booked by the clinic. */
export const PATIENT_PURPOSES = ['initial', 'review'] as const satisfies readonly ConsultPurpose[];

export const patientSlotsQuery = z.object({ purpose: z.enum(PATIENT_PURPOSES), from: instant.optional(), to: instant.optional() });

export const patientBookBody = z
  .object({
    purpose: z.enum(PATIENT_PURPOSES),
    mode: z.enum(CONSULT_MODES),
    startsAt: instant,
    /** The brand the patient app is on (CNS24). */
    brandId: z.uuid(),
    /** The program a first consult is for, one of this brand's; its intake must be done (CNS21). */
    programId: z.uuid().optional(),
  })
  .strict();
export type PatientBookConsult = z.infer<typeof patientBookBody>;

export const patientRescheduleBody = z.object({ startsAt: instant, mode: z.enum(CONSULT_MODES).optional() }).strict();

/** One of the patient's own consults, as the patient app shows it (CNS22): no notes, no evidence, no other patient. */
export const patientConsult = z.object({
  consultId: z.uuid(),
  status: z.enum(CONSULT_STATUSES),
  mode: z.enum(CONSULT_MODES),
  purpose: z.enum(CONSULT_PURPOSES),
  /** Null only for a consult waiting in the on-demand queue, which has no time yet. */
  startsAt: instant.nullable(),
  endsAt: instant.nullable(),
  /** How the clinic names the clinician; null when it hasn't given a name. */
  clinicianName: z.string().nullable(),
  /** The patient may move or cancel it online (CNS23). */
  canChange: z.boolean(),
  /** The patient may join the video room now. False until joining arrives. */
  canJoin: z.boolean(),
});
export type PatientConsult = z.infer<typeof patientConsult>;

export const patientConsultsReply = z.object({ consults: z.array(patientConsult) });
