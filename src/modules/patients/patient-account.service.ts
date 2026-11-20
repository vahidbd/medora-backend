import { and, eq } from 'drizzle-orm';
import { patientAddresses, patientContacts, patientSignIns, patients, tenants } from '../../db/schema/index.js';
import type { ContactKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { encryptField } from '../../lib/field-crypto.js';
import { isTimeZone } from '../../lib/time.js';
import type { PatientAuth } from '../../plugins/patient-auth.js';
import { assertAcceptingPatients } from '../brands/index.js';
import { DATE_OF_BIRTH_MESSAGES, dateOfBirthProblem, isMedicareNumber, isValidTo, normaliseEmail, normaliseMobile } from './patient-details.js';
import type { AccountInput, ProfileChange } from './patients.schemas.js';
import { MEDICARE_PURPOSE } from './patients.service.js';

/**
 * A patient's own account (docs/decisions/patients.md IDN2, IDN3, IDN5 to
 * IDN8, IDN20): creating it through a brand that takes new patients, with
 * the date of birth and the age check, confirming the date of birth on a new
 * sign-in session, and changing their own details.
 */

const RECORD = 'clinical.patients' as const;

async function tenantTimeZone(tx: TenantTx): Promise<string> {
  const [row] = await tx.db.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tx.context.tenantId));
  return row?.timeZone ?? 'Australia/Sydney';
}

export async function assertDateOfBirth(tx: TenantTx, dateOfBirth: string): Promise<void> {
  const problem = dateOfBirthProblem(dateOfBirth, new Date(), await tenantTimeZone(tx));
  if (problem) throw new BadRequestError(DATE_OF_BIRTH_MESSAGES[problem], problem === 'under_age' ? 'under_age' : 'date_of_birth');
}

/** The new record's own context: from here on the patient is the actor (IDN2). */
const asPatient = (tx: TenantTx, patientId: string): TenantTx => ({ ...tx, context: { ...tx.context, actor: { type: 'patient', patientId } } });

async function setContact(tx: TenantTx, patientId: string, kind: ContactKind, value: string, verified: boolean): Promise<void> {
  const tenantId = tx.context.tenantId;
  const verifiedAt = verified ? new Date() : null;
  await tx.db
    .insert(patientContacts)
    .values({ tenantId, patientId, kind, value, verifiedAt })
    .onConflictDoUpdate({
      target: [patientContacts.tenantId, patientContacts.patientId, patientContacts.kind],
      set: { value, verifiedAt, updatedAt: new Date() },
    });
}

/**
 * Create the signed-in patient's record in this tenant (IDN-01, IDN-03,
 * IDN-07). The contact the sign-in verified is stored as verified; one typed
 * in is not. Typing the date of birth here confirms this session (IDN3).
 */
export async function createAccount(tx: TenantTx, sign: PatientAuth, input: AccountInput): Promise<string> {
  if (sign.patientId) throw new BusinessRuleError('You already have an account here. Sign in instead.', 'already_registered');
  await assertAcceptingPatients(tx, input.brandId);
  await assertDateOfBirth(tx, input.dateOfBirth);

  const typedEmail = input.email === undefined ? null : normaliseEmail(input.email);
  if (input.email !== undefined && !typedEmail) throw new BadRequestError('Enter a valid email address', 'email');
  const typedMobile = input.mobile === undefined ? null : normaliseMobile(input.mobile);
  if (input.mobile !== undefined && !typedMobile) throw new BadRequestError('Enter an Australian mobile number, like 0412 345 678', 'mobile');
  const signInMobile = sign.phone ? normaliseMobile(sign.phone) : null;
  const email = sign.email ?? typedEmail;
  const mobile = signInMobile ?? typedMobile;
  if (!email && !mobile) throw new BadRequestError('Add an email address or a mobile number so your care team can reach you', 'contact_needed');

  const tenantId = tx.context.tenantId;
  const [created] = await tx.db
    .insert(patients)
    .values({
      tenantId,
      clerkUserId: sign.clerkUserId,
      givenName: input.givenName,
      familyName: input.familyName,
      preferredName: input.preferredName ?? null,
      dateOfBirth: input.dateOfBirth,
      sex: input.sex,
    })
    .returning({ id: patients.id });
  const patientId = created!.id;
  const own = asPatient(tx, patientId);

  if (email) await setContact(own, patientId, 'email', email, email === sign.email);
  if (mobile) await setContact(own, patientId, 'mobile', mobile, mobile === signInMobile);
  await own.db.insert(patientSignIns).values({ tenantId, patientId, sessionId: sign.sessionId });

  await audit(own, { action: 'patient.created', zone: 'clinical', recordTable: RECORD, recordId: patientId });
  await emitEvent(own, { type: 'patient.created', recordTable: RECORD, recordId: patientId });
  return patientId;
}

/** Five wrong dates of birth per patient in 15 minutes, then wait (IDN3). */
export const DATE_OF_BIRTH_LIMIT = { name: 'date-of-birth-check', max: 5, windowSeconds: 900 } as const;

/**
 * Check the date of birth a signed-in patient typed against their record
 * (IDN-07). A match confirms this sign-in session. Returns false on a
 * mismatch so the caller can commit the audit entry before refusing.
 */
export async function confirmDateOfBirth(tx: TenantTx, sign: PatientAuth, dateOfBirth: string): Promise<boolean> {
  if (!sign.patientId) throw new ForbiddenError('Create your account first', 'no_patient_record');
  const tenantId = tx.context.tenantId;
  const [row] = await tx.db
    .select({ dateOfBirth: patients.dateOfBirth })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, sign.patientId)));
  if (!row) throw new NotFoundError('Patient');
  const record = { zone: 'clinical', recordTable: RECORD, recordId: sign.patientId } as const;
  if (row.dateOfBirth !== dateOfBirth) {
    await audit(tx, { action: 'patient.date_of_birth_refused', ...record });
    return false;
  }
  await tx.db.insert(patientSignIns).values({ tenantId, patientId: sign.patientId, sessionId: sign.sessionId }).onConflictDoNothing();
  await audit(tx, { action: 'patient.sign_in_confirmed', ...record });
  return true;
}

const LEGAL_FIELDS = ['givenName', 'familyName', 'dateOfBirth', 'sex'] as const;

/**
 * A patient changes their own details (IDN5 to IDN7). Legal name, date of
 * birth and sex lock once identity is verified (IDN6); support changes them
 * with a reason and a new check.
 */
export async function changeProfile(tx: TenantTx, patientId: string, change: ProfileChange): Promise<void> {
  const tenantId = tx.context.tenantId;
  const [current] = await tx.db
    .select({ identityStatus: patients.identityStatus, givenName: patients.givenName, familyName: patients.familyName, dateOfBirth: patients.dateOfBirth, sex: patients.sex })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)))
    .for('update');
  if (!current) throw new NotFoundError('Patient');

  const legalChanges = LEGAL_FIELDS.filter((field) => change[field] !== undefined && change[field] !== current[field]);
  if (legalChanges.length > 0 && current.identityStatus === 'verified') {
    throw new ForbiddenError('Your legal name, date of birth and sex are locked once your identity is checked. Contact support to change them.', 'identity_locked');
  }
  if (change.dateOfBirth !== undefined) await assertDateOfBirth(tx, change.dateOfBirth);
  if (change.timeZone && !isTimeZone(change.timeZone)) throw new BadRequestError('That time zone is not known', 'time_zone');

  const fields: string[] = [...legalChanges];
  const set: Partial<typeof patients.$inferInsert> = {};
  for (const field of legalChanges) Object.assign(set, { [field]: change[field] });
  if (change.preferredName !== undefined) {
    set.preferredName = change.preferredName;
    fields.push('preferredName');
  }
  if (change.timeZone !== undefined) {
    set.timeZone = change.timeZone;
    fields.push('timeZone');
  }
  if (change.medicare !== undefined) {
    if (change.medicare && !isMedicareNumber(change.medicare.number)) throw new BadRequestError('Check your Medicare number: it is not a valid card number', 'medicare');
    if (change.medicare?.validTo && !isValidTo(change.medicare.validTo)) throw new BadRequestError('Use the valid-to month on your card, as YYYY-MM', 'medicare');
    set.medicare = change.medicare ? await encryptField(tx, MEDICARE_PURPOSE, JSON.stringify(change.medicare)) : null;
    fields.push('medicare');
  }
  if (Object.keys(set).length > 0) {
    await tx.db.update(patients).set({ ...set, updatedAt: new Date() }).where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)));
  }
  if (change.mobile !== undefined) {
    const mobile = normaliseMobile(change.mobile);
    if (!mobile) throw new BadRequestError('Enter an Australian mobile number, like 0412 345 678', 'mobile');
    await setContact(tx, patientId, 'mobile', mobile, false);
    fields.push('mobile');
  }
  if (change.address) {
    const address = { line1: change.address.line1, line2: change.address.line2 ?? null, suburb: change.address.suburb, state: change.address.state, postcode: change.address.postcode };
    await tx.db
      .insert(patientAddresses)
      .values({ tenantId, patientId, kind: 'home', ...address })
      .onConflictDoUpdate({ target: [patientAddresses.tenantId, patientAddresses.patientId, patientAddresses.kind], set: { ...address, updatedAt: new Date() } });
    fields.push('address');
  }
  if (fields.length === 0) return;
  const record = { recordTable: RECORD, recordId: patientId } as const;
  await audit(tx, { action: 'patient.updated', zone: 'clinical', ...record, details: { fields: fields.join(',') } });
  await emitEvent(tx, { type: 'patient.updated', ...record, payload: { fields } });
}
