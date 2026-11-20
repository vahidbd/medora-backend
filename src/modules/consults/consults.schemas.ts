import { z } from 'zod';
import { CANCELLATION_REASONS, type CancellationReason, CONSULT_MODES, CONSULT_PURPOSES, CONSULT_STATUSES } from '../../db/schema/values.js';

/** Request and reply shapes for booking (docs/decisions/consults.md CNS11 to CNS16). Times are instants; screens choose the zone. */

const instant = z.iso.datetime({ offset: true });

export const consultParams = z.object({ consultId: z.uuid() });

export const scheduleQuery = z.object({
  from: instant,
  to: instant,
  clinicianUserId: z.uuid().optional(),
  patientId: z.uuid().optional(),
});

export const slotsQuery = z.object({
  clinicianUserId: z.uuid(),
  from: instant.optional(),
  to: instant.optional(),
});

/** One entry in the schedule: exactly these fields, never anything from the evidence or the consult's content (CNS11). */
export const scheduleEntry = z.object({
  consultId: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string(),
  clinicianUserId: z.uuid(),
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
  /** The clinician's zone, the one their hours are in (ADR 0017). */
  timeZone: z.string(),
  slots: z.array(z.object({ startsAt: instant, endsAt: instant })),
});

export const bookBody = z.object({
  patientId: z.uuid(),
  clinicianUserId: z.uuid(),
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
});
export type RescheduleConsult = z.infer<typeof rescheduleBody>;

/** `rescheduled` is set only by a move (CNS14), so it can't be chosen. */
export const CHOOSABLE_CANCELLATION_REASONS = ['patient_request', 'clinician_unavailable', 'booked_in_error', 'other'] as const satisfies readonly CancellationReason[];
export const cancelBody = z.object({ reason: z.enum(CHOOSABLE_CANCELLATION_REASONS) });
