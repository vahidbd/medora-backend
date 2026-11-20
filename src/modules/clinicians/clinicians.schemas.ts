import { z } from 'zod';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_WITHDRAWAL_REASONS,
  ENDORSEMENTS,
  PROFESSIONS,
  REGISTERING_BODIES,
  REGISTRATION_STATUSES,
  REGISTRATION_TYPES,
  SUSPENSION_REASONS,
  TIME_OFF_REASONS,
} from '../../db/schema/values.js';
import { isTimeZone } from '../../lib/time.js';
import { STANDING_REASONS, STANDING_WARNINGS } from './standing.js';

const day = z.iso.date();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, like 09:30');
const timeZone = z.string().refine(isTimeZone, 'Use a time zone name, like Australia/Sydney');

export const clinicianParams = z.object({ clinicianId: z.uuid() });
export const credentialParams = clinicianParams.extend({ credentialId: z.uuid() });
export const timeOffParams = clinicianParams.extend({ timeOffId: z.uuid() });

export const standingSchema = z.object({
  mayConsult: z.boolean(),
  mayPrescribe: z.boolean(),
  reasons: z.array(z.enum(STANDING_REASONS)),
  warnings: z.array(z.enum(STANDING_WARNINGS)),
});

export const clinicianSummary = z.object({
  clinicianId: z.uuid(),
  membershipId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  profession: z.enum(PROFESSIONS),
  timeZone: z.string(),
  suspension: z.object({ at: z.iso.datetime(), reason: z.enum(SUSPENSION_REASONS) }).nullable(),
  standing: standingSchema,
});
export type ClinicianSummary = z.infer<typeof clinicianSummary>;

export const credentialSchema = z.object({
  credentialId: z.uuid(),
  kind: z.enum(CREDENTIAL_KINDS),
  reference: z.string().nullable(),
  registeringBody: z.enum(REGISTERING_BODIES).nullable(),
  registrationType: z.enum(REGISTRATION_TYPES).nullable(),
  registrationStatus: z.enum(REGISTRATION_STATUSES).nullable(),
  conditions: z.string().nullable(),
  endorsement: z.enum(ENDORSEMENTS).nullable(),
  insurer: z.string().nullable(),
  coversTelehealthNewPatients: z.boolean().nullable(),
  startsOn: day.nullable(),
  expiresOn: day.nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  conditionsReviewedAt: z.iso.datetime().nullable(),
  withdrawnAt: z.iso.datetime().nullable(),
  withdrawalReason: z.enum(CREDENTIAL_WITHDRAWAL_REASONS).nullable(),
  createdAt: z.iso.datetime(),
  /** The one that counts for its kind now (WRK2). */
  counts: z.boolean(),
});
export type CredentialReply = z.infer<typeof credentialSchema>;

export const hoursBlock = z
  .object({ weekday: z.number().int().min(1).max(7), startsAt: clock, endsAt: clock, slotMinutes: z.number().int().min(5).max(120).default(15) })
  .refine((block) => block.startsAt < block.endsAt, { message: 'A block ends after it starts', path: ['endsAt'] });
export type HoursBlock = z.output<typeof hoursBlock>;

export const timeOffSchema = z.object({
  timeOffId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  reason: z.enum(TIME_OFF_REASONS),
});
export type TimeOffReply = z.infer<typeof timeOffSchema>;

export const clinicianDetail = clinicianSummary.extend({
  /** Only for someone who manages clinicians, and for the clinician themselves (WRK4). */
  credentials: z.array(credentialSchema).nullable(),
  hours: z.array(hoursBlock),
  /** Time off that hasn't ended yet. */
  timeOff: z.array(timeOffSchema),
});
export type ClinicianDetail = z.infer<typeof clinicianDetail>;

export const clinicianListReply = z.object({ clinicians: z.array(clinicianSummary) });

export const createClinicianBody = z.object({ membershipId: z.uuid(), profession: z.enum(PROFESSIONS), timeZone }).strict();
export type CreateClinician = z.infer<typeof createClinicianBody>;

export const updateClinicianBody = z
  .object({ profession: z.enum(PROFESSIONS).optional(), timeZone: timeZone.optional() })
  .strict()
  .refine((body) => body.profession !== undefined || body.timeZone !== undefined, { message: 'Send a profession, a time zone, or both' });
export type UpdateClinician = z.infer<typeof updateClinicianBody>;

export const suspendBody = z.object({ reason: z.enum(SUSPENSION_REASONS) }).strict();

const text = (max: number) => z.string().trim().min(1).max(max);

export const addCredentialBody = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('registration'),
      registeringBody: z.enum(REGISTERING_BODIES),
      reference: text(40),
      registrationType: z.enum(REGISTRATION_TYPES).nullable().default(null),
      registrationStatus: z.enum(REGISTRATION_STATUSES),
      conditions: text(2000).nullable().default(null),
      startsOn: day.nullable().default(null),
      expiresOn: day,
    })
    .strict(),
  z
    .object({
      kind: z.literal('endorsement'),
      endorsement: z.enum(ENDORSEMENTS),
      reference: text(40).nullable().default(null),
      startsOn: day.nullable().default(null),
      expiresOn: day.nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal('indemnity'),
      insurer: text(120),
      reference: text(60).nullable().default(null),
      coversTelehealthNewPatients: z.boolean(),
      startsOn: day.nullable().default(null),
      expiresOn: day,
    })
    .strict(),
]);
export type AddCredential = z.output<typeof addCredentialBody>;

export const withdrawCredentialBody = z.object({ reason: z.enum(['entered_in_error', 'no_longer_held']) }).strict();

export const replaceHoursBody = z.object({ hours: z.array(hoursBlock).max(50) }).strict();
export const hoursReply = z.object({ hours: z.array(hoursBlock) });

export const addTimeOffBody = z
  .object({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }), reason: z.enum(TIME_OFF_REASONS) })
  .strict()
  .refine((body) => new Date(body.startsAt) < new Date(body.endsAt), { message: 'Time off ends after it starts', path: ['endsAt'] });

export const removedReply = z.object({ removed: z.literal(true) });
