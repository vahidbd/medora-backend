import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { patientAddresses, patientContacts, patients, tenants } from '../../db/schema/index.js';
import type { AuState, ContactKind, IdentityStatus, Sex } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { decryptOptional } from '../../lib/field-crypto.js';
import { normaliseEmail, normaliseMobile } from './patient-details.js';
import type { MedicareInput, PatientProfile } from './patients.schemas.js';

/**
 * Reading patients (docs/decisions/patients.md). Every read of a patient's
 * record writes a `patient.read` audit entry (or a purpose-named one) in the
 * same transaction, one per patient (ADR 0008, IDN9). Other modules use these
 * through the front door, src/modules/patients/index.ts.
 */

export const MEDICARE_PURPOSE = 'clinical.patients.medicare' as const;
const RECORD = 'clinical.patients' as const;

export interface PatientSummary {
  patientId: string;
  givenName: string;
  familyName: string;
  preferredName: string | null;
  /** Preferred (or given) name, then family name. */
  displayName: string;
  dateOfBirth: string;
  sex: Sex;
  timeZone: string | null;
  identityStatus: IdentityStatus;
}

export interface PatientContact {
  patientId: string;
  givenName: string;
  dateOfBirth: string;
  email: string | null;
  mobile: string | null;
  /** The patient's zone, else the tenant's (ADR 0017). */
  timeZone: string;
}

export interface PatientAddress {
  line1: string;
  line2: string | null;
  suburb: string;
  state: AuState;
  postcode: string;
}

/** What prescribing needs to create the patient in the prescribing system. */
export interface PrescribingPatient {
  patientId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: Sex;
  email: string | null;
  mobile: string | null;
  address: PatientAddress | null;
  medicare: MedicareInput | null;
  /** Filled once the HI Service lookup exists (IDN-04). */
  ihi: string | null;
  identityStatus: IdentityStatus;
}

const summaryColumns = {
  patientId: patients.id,
  givenName: patients.givenName,
  familyName: patients.familyName,
  preferredName: patients.preferredName,
  dateOfBirth: patients.dateOfBirth,
  sex: patients.sex,
  timeZone: patients.timeZone,
  identityStatus: patients.identityStatus,
  createdAt: patients.createdAt,
};

type SummaryRow = { [K in keyof typeof summaryColumns]: K extends 'createdAt' ? Date : K extends 'preferredName' | 'timeZone' ? string | null : string };

export function displayNameOf(row: { givenName: string; familyName: string; preferredName: string | null }): string {
  return `${row.preferredName ?? row.givenName} ${row.familyName}`;
}

function toSummary(row: SummaryRow): PatientSummary {
  return {
    patientId: row.patientId,
    givenName: row.givenName,
    familyName: row.familyName,
    preferredName: row.preferredName,
    displayName: displayNameOf(row),
    dateOfBirth: row.dateOfBirth,
    sex: row.sex as Sex,
    timeZone: row.timeZone,
    identityStatus: row.identityStatus as IdentityStatus,
  };
}

async function auditRead(tx: TenantTx, patientId: string, action: `patient.${string}` = 'patient.read'): Promise<void> {
  await audit(tx, { action, zone: 'clinical', recordTable: RECORD, recordId: patientId });
}

export async function findPatient(tx: TenantTx, patientId: string): Promise<PatientSummary | null> {
  return (await findPatients(tx, [patientId])).get(patientId) ?? null;
}

/** Summaries for several patients at once; ids not in this tenant are left out. */
export async function findPatients(tx: TenantTx, patientIds: readonly string[]): Promise<Map<string, PatientSummary>> {
  const ids = [...new Set(patientIds)];
  const found = new Map<string, PatientSummary>();
  if (ids.length === 0) return found;
  const rows = await tx.db.select(summaryColumns).from(patients).where(and(eq(patients.tenantId, tx.context.tenantId), inArray(patients.id, ids)));
  for (const row of rows) {
    await auditRead(tx, row.patientId);
    found.set(row.patientId, toSummary(row));
  }
  return found;
}

async function contactsOf(tx: TenantTx, patientId: string): Promise<Record<ContactKind, string | null>> {
  const rows = await tx.db
    .select({ kind: patientContacts.kind, value: patientContacts.value })
    .from(patientContacts)
    .where(and(eq(patientContacts.tenantId, tx.context.tenantId), eq(patientContacts.patientId, patientId)));
  return {
    email: rows.find((row) => row.kind === 'email')?.value ?? null,
    mobile: rows.find((row) => row.kind === 'mobile')?.value ?? null,
  };
}

async function addressOf(tx: TenantTx, patientId: string): Promise<PatientAddress | null> {
  const [row] = await tx.db
    .select({ line1: patientAddresses.line1, line2: patientAddresses.line2, suburb: patientAddresses.suburb, state: patientAddresses.state, postcode: patientAddresses.postcode })
    .from(patientAddresses)
    .where(and(eq(patientAddresses.tenantId, tx.context.tenantId), eq(patientAddresses.patientId, patientId), eq(patientAddresses.kind, 'home')));
  return row ? { ...row, state: row.state as AuState } : null;
}

async function tenantTimeZone(tx: TenantTx): Promise<string> {
  const [row] = await tx.db.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tx.context.tenantId));
  return row?.timeZone ?? 'Australia/Sydney';
}

/** How to reach a patient, for messages and for checking a caller's identity. */
export async function findPatientContact(tx: TenantTx, patientId: string): Promise<PatientContact | null> {
  const summary = await findPatient(tx, patientId);
  if (!summary) return null;
  const contacts = await contactsOf(tx, patientId);
  return { patientId, givenName: summary.givenName, dateOfBirth: summary.dateOfBirth, ...contacts, timeZone: summary.timeZone ?? (await tenantTimeZone(tx)) };
}

/** Patients whose email or mobile is exactly this (after normalising). One audit entry per search, with the count only. */
export async function findPatientsByContact(tx: TenantTx, by: { email: string } | { mobile: string }): Promise<string[]> {
  const [kind, value] = 'email' in by ? (['email', normaliseEmail(by.email)] as const) : (['mobile', normaliseMobile(by.mobile)] as const);
  const rows = value
    ? await tx.db
        .select({ patientId: patientContacts.patientId })
        .from(patientContacts)
        .where(and(eq(patientContacts.tenantId, tx.context.tenantId), eq(patientContacts.kind, kind), eq(patientContacts.value, value)))
    : [];
  await audit(tx, { action: 'patient.searched', zone: 'clinical', recordTable: RECORD, recordId: '*', details: { by: kind, matches: rows.length } });
  return rows.map((row) => row.patientId);
}

async function medicareOf(tx: TenantTx, sealed: string | null): Promise<MedicareInput | null> {
  const opened = await decryptOptional(tx, MEDICARE_PURPOSE, sealed);
  return opened ? (JSON.parse(opened) as MedicareInput) : null;
}

/** Everything prescribing sends to the prescribing system, decrypted, audited as `patient.read_for_prescribing`. */
export async function getPatientForPrescribing(tx: TenantTx, patientId: string): Promise<PrescribingPatient | null> {
  const [row] = await tx.db
    .select({ ...summaryColumns, medicare: patients.medicare })
    .from(patients)
    .where(and(eq(patients.tenantId, tx.context.tenantId), eq(patients.id, patientId)));
  if (!row) return null;
  await auditRead(tx, patientId, 'patient.read_for_prescribing');
  const summary = toSummary(row);
  return {
    patientId,
    givenName: summary.givenName,
    familyName: summary.familyName,
    dateOfBirth: summary.dateOfBirth,
    sex: summary.sex,
    ...(await contactsOf(tx, patientId)),
    address: await addressOf(tx, patientId),
    medicare: await medicareOf(tx, row.medicare),
    ihi: null,
    identityStatus: summary.identityStatus,
  };
}

export function maskMedicare(medicare: MedicareInput | null): PatientProfile['medicare'] {
  if (!medicare) return null;
  return { masked: `•••• ••${medicare.number.slice(6, 9)} ${medicare.number.slice(9)}`, irn: medicare.irn, validTo: medicare.validTo };
}

/** The whole identity record, for the patient themselves and for staff with patients:read. Audited as a read. */
export async function getPatientProfile(tx: TenantTx, patientId: string): Promise<PatientProfile | null> {
  const [row] = await tx.db
    .select({ ...summaryColumns, medicare: patients.medicare })
    .from(patients)
    .where(and(eq(patients.tenantId, tx.context.tenantId), eq(patients.id, patientId)));
  if (!row) return null;
  await auditRead(tx, patientId);
  return {
    ...toSummary(row),
    ...(await contactsOf(tx, patientId)),
    address: await addressOf(tx, patientId),
    medicare: maskMedicare(await medicareOf(tx, row.medicare)),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The staff list: newest first, or matching a name, exact email or exact mobile. One `patient.listed` entry per patient shown. */
export async function listPatients(tx: TenantTx, query: { search?: string | undefined; limit: number }) {
  const tenantId = tx.context.tenantId;
  const search = query.search?.trim();
  let where = eq(patients.tenantId, tenantId);
  if (search) {
    const email = normaliseEmail(search);
    const mobile = normaliseMobile(search);
    const contact = email ?? mobile;
    const byContact = contact
      ? sql`${patients.id} in (select patient_id from clinical.patient_contacts where tenant_id = ${tenantId} and value = ${contact})`
      : sql`false`;
    const words = search.replace(/[%_\\]/g, '').split(/\s+/).filter(Boolean);
    const byName = words.length
      ? and(...words.map((word) => or(ilike(patients.givenName, `${word}%`), ilike(patients.familyName, `${word}%`), ilike(patients.preferredName, `${word}%`))))
      : sql`false`;
    where = and(where, or(byContact, byName))!;
  }
  const rows = await tx.db
    .select(summaryColumns)
    .from(patients)
    .where(where)
    .orderBy(search ? asc(patients.familyName) : sql`${patients.createdAt} desc`)
    .limit(query.limit);
  for (const row of rows) await auditRead(tx, row.patientId, 'patient.listed');
  return rows.map((row) => ({
    patientId: row.patientId,
    displayName: displayNameOf(row),
    givenName: row.givenName,
    familyName: row.familyName,
    dateOfBirth: row.dateOfBirth,
    identityStatus: row.identityStatus as IdentityStatus,
    createdAt: row.createdAt.toISOString(),
  }));
}
