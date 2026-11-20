import { z } from 'zod';
import { AU_STATES, IDENTITY_STATUSES, SEXES } from '../../db/schema/values.js';

/** Request and reply shapes for patients (ADR 0014). Field names follow GLOSSARY.md. */

const name = z.string().trim().min(1).max(100);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const sexSchema = z.enum(SEXES);
export const identityStatusSchema = z.enum(IDENTITY_STATUSES);

export const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(120),
    line2: z.string().trim().max(120).nullable().optional(),
    suburb: z.string().trim().min(1).max(60),
    state: z.enum(AU_STATES),
    postcode: z.string().regex(/^\d{4}$/, 'Use a 4-digit postcode'),
  })
  .strict();
export type AddressInput = z.infer<typeof addressSchema>;

export const medicareSchema = z
  .object({
    number: z.string().regex(/^\d{10}$/, 'A Medicare number has 10 digits'),
    irn: z.string().regex(/^[1-9]$/, 'The reference number is the single digit beside your name').nullable(),
    validTo: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM').nullable(),
  })
  .strict();
export type MedicareInput = z.infer<typeof medicareSchema>;

export const accountBody = z
  .object({
    givenName: name,
    familyName: name,
    preferredName: name.nullable().optional(),
    dateOfBirth: calendarDate,
    sex: sexSchema,
    /** Needed when the sign-in has no verified email or mobile of that kind. */
    email: z.string().max(254).optional(),
    mobile: z.string().max(20).optional(),
  })
  .strict();
export type AccountInput = z.infer<typeof accountBody>;

export const confirmDateOfBirthBody = z.object({ dateOfBirth: calendarDate }).strict();

export const profileChangeBody = z
  .object({
    preferredName: name.nullable().optional(),
    mobile: z.string().max(20).optional(),
    timeZone: z.string().max(64).nullable().optional(),
    address: addressSchema.optional(),
    medicare: medicareSchema.nullable().optional(),
    /** Legal details: only while identity is unverified (IDN6). */
    givenName: name.optional(),
    familyName: name.optional(),
    dateOfBirth: calendarDate.optional(),
    sex: sexSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one change' });
export type ProfileChange = z.infer<typeof profileChangeBody>;

const address = z.object({ line1: z.string(), line2: z.string().nullable(), suburb: z.string(), state: z.enum(AU_STATES), postcode: z.string() });

/** Medicare as people see it: the number masked to its last four digits (GOV-10). */
const maskedMedicare = z.object({ masked: z.string(), irn: z.string().nullable(), validTo: z.string().nullable() });

export const patientProfile = z.object({
  patientId: z.uuid(),
  givenName: z.string(),
  familyName: z.string(),
  preferredName: z.string().nullable(),
  displayName: z.string(),
  dateOfBirth: z.string(),
  sex: sexSchema,
  timeZone: z.string().nullable(),
  identityStatus: identityStatusSchema,
  email: z.string().nullable(),
  mobile: z.string().nullable(),
  address: address.nullable(),
  medicare: maskedMedicare.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type PatientProfile = z.infer<typeof patientProfile>;

export const patientMeReply = patientProfile.extend({
  /** Consent kinds the patient still has to give (filled by the consents module). */
  consentsNeeded: z.array(z.string()),
  /** The programs the patient is in (filled by the programs module). */
  programs: z.array(z.object({ programId: z.uuid(), name: z.string(), measurements: z.array(z.string()), checkInEveryDays: z.number().int().nullable() })),
});

export const confirmedReply = z.object({ confirmed: z.literal(true) });

export const patientListItem = z.object({
  patientId: z.uuid(),
  displayName: z.string(),
  givenName: z.string(),
  familyName: z.string(),
  dateOfBirth: z.string(),
  identityStatus: identityStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export const patientListQuery = z
  .object({
    /** A name, an exact email or an exact mobile number. */
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const patientListReply = z.object({ patients: z.array(patientListItem) });
export const patientParams = z.object({ patientId: z.uuid() });
