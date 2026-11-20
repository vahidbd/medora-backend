import { and, desc, eq } from 'drizzle-orm';
import { identityChecks, patients } from '../../db/schema/index.js';
import type { IdentityDocument, IdentityMethod, IdentityOutcome, IdentityStatus, IhiRecordStatus, IhiStatus, Sex } from '../../db/schema/values.js';
import { type TenantContext, type TenantTx, withTenant } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { AppError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { decryptOptional, encryptField } from '../../lib/field-crypto.js';
import { assertConsents } from './consents.service.js';
import { assertDateOfBirth } from './patient-account.service.js';
import { hiService } from './hi-service.js';
import { type DocumentDetails, documentTypeOf, identityGateway } from './identity-gateway.js';
import { IHI_PURPOSE, MEDICARE_PURPOSE } from './patients.service.js';
import type { MedicareInput } from './patients.schemas.js';

/**
 * Checking who a patient is (IDN-02, IDN-04, docs/decisions/patients.md IDN16
 * to IDN19): online against one document, or by staff who sighted it, then
 * the IHI lookup. Outside calls happen between two transactions, so no row
 * stays locked while a gateway answers.
 */

export const MAX_IDENTITY_FAILURES = 3;
const RECORD = 'clinical.patients' as const;
const CHECKS = 'clinical.identity_checks' as const;

export interface IdentityCheckRow {
  method: IdentityMethod;
  documentType: IdentityDocument;
  outcome: IdentityOutcome;
  at: string;
  checkedBy: string | null;
}

export interface IdentityState {
  identityStatus: IdentityStatus;
  attemptsLeft: number;
  /** The check that verified the patient, if one did: prescribers see "verified manually" (IDN17). */
  verification: { method: IdentityMethod; documentType: IdentityDocument; at: string } | null;
  ihi: { found: boolean; status: IhiStatus | null; recordStatus: IhiRecordStatus | null; checkedAt: string } | null;
  checks: IdentityCheckRow[];
}

interface Legal {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: Sex;
}

const legalColumns = { givenName: patients.givenName, familyName: patients.familyName, dateOfBirth: patients.dateOfBirth, sex: patients.sex };
const sameLegal = (a: Legal, b: Legal) => a.givenName === b.givenName && a.familyName === b.familyName && a.dateOfBirth === b.dateOfBirth && a.sex === b.sex;

async function lockPatient(tx: TenantTx, patientId: string) {
  const [row] = await tx.db
    .select({ ...legalColumns, identityStatus: patients.identityStatus, identityFailures: patients.identityFailures, medicare: patients.medicare })
    .from(patients)
    .where(and(eq(patients.tenantId, tx.context.tenantId), eq(patients.id, patientId)))
    .for('update');
  if (!row) throw new NotFoundError('Patient');
  return { ...row, sex: row.sex as Sex, identityStatus: row.identityStatus as IdentityStatus };
}

const setIdentity = (tx: TenantTx, patientId: string, set: Partial<typeof patients.$inferInsert>) =>
  tx.db.update(patients).set({ ...set, updatedAt: new Date() }).where(and(eq(patients.tenantId, tx.context.tenantId), eq(patients.id, patientId)));

async function verified(tx: TenantTx, patientId: string, method: IdentityMethod, documentType: IdentityDocument): Promise<void> {
  await setIdentity(tx, patientId, { identityStatus: 'verified', identityFailures: 0 });
  await emitEvent(tx, { type: 'patient.identity_verified', recordTable: RECORD, recordId: patientId, payload: { method, documentType } });
}

/** The patient's identity checks and IHI, for staff and for the patient's own screen. Audited as one read. */
export async function identityState(tx: TenantTx, patientId: string): Promise<IdentityState> {
  const tenantId = tx.context.tenantId;
  const [row] = await tx.db
    .select({ identityStatus: patients.identityStatus, failures: patients.identityFailures, ihi: patients.ihi, ihiStatus: patients.ihiStatus, ihiRecordStatus: patients.ihiRecordStatus, ihiCheckedAt: patients.ihiCheckedAt })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)));
  if (!row) throw new NotFoundError('Patient');
  const checks = await tx.db
    .select({ method: identityChecks.method, documentType: identityChecks.documentType, outcome: identityChecks.outcome, at: identityChecks.at, checkedBy: identityChecks.checkedBy })
    .from(identityChecks)
    .where(and(eq(identityChecks.tenantId, tenantId), eq(identityChecks.patientId, patientId)))
    .orderBy(desc(identityChecks.at), desc(identityChecks.id));
  await audit(tx, { action: 'patient.identity_read', zone: 'clinical', recordTable: RECORD, recordId: patientId });
  const rows: IdentityCheckRow[] = checks.map((check) => ({
    method: check.method as IdentityMethod,
    documentType: check.documentType as IdentityDocument,
    outcome: check.outcome as IdentityOutcome,
    at: check.at.toISOString(),
    checkedBy: check.checkedBy,
  }));
  const status = row.identityStatus as IdentityStatus;
  const success = status === 'verified' ? rows.find((check) => check.outcome === 'verified') : undefined;
  return {
    identityStatus: status,
    attemptsLeft: status === 'unverified' ? MAX_IDENTITY_FAILURES - row.failures : 0,
    verification: success ? { method: success.method, documentType: success.documentType, at: success.at } : null,
    ihi: row.ihiCheckedAt
      ? { found: row.ihi !== null, status: row.ihiStatus as IhiStatus | null, recordStatus: row.ihiRecordStatus as IhiRecordStatus | null, checkedAt: row.ihiCheckedAt.toISOString() }
      : null,
    checks: rows,
  };
}

/** For prescribing and booking (IDN18): whether the patient's identity is verified. Audited. */
export async function isIdentityVerified(tx: TenantTx, patientId: string): Promise<boolean> {
  const [row] = await tx.db
    .select({ identityStatus: patients.identityStatus })
    .from(patients)
    .where(and(eq(patients.tenantId, tx.context.tenantId), eq(patients.id, patientId)));
  if (!row) throw new NotFoundError('Patient');
  await audit(tx, { action: 'patient.identity_read', zone: 'clinical', recordTable: RECORD, recordId: patientId });
  return row.identityStatus === 'verified';
}

/** Refuse with 409 `identity_not_verified` until the patient's identity is verified (IDN18). */
export async function assertIdentityVerified(tx: TenantTx, patientId: string): Promise<void> {
  if (!(await isIdentityVerified(tx, patientId))) throw new AppError(409, 'identity_not_verified', 'Check your identity first. It takes a minute, with your licence, passport or Medicare card.');
}

/**
 * The patient checks one document online (IDN16). Needs the identity check
 * consent; three checks that don't match lock online checks until support
 * reopens them. Then looks up the IHI (IDN19).
 */
export async function checkIdentityDocument(context: TenantContext, patientId: string, document: DocumentDetails): Promise<IdentityState> {
  const gateway = identityGateway();
  if (!gateway) throw new BusinessRuleError("Online ID checks aren't available yet. Contact support and they'll check your ID with you.", 'identity_check_unavailable');
  const documentType = documentTypeOf(document);
  const before = await withTenant(context, async (tx) => {
    const patient = await lockPatient(tx, patientId);
    if (patient.identityStatus === 'verified') throw new BusinessRuleError('Your identity is already checked', 'already_verified');
    if (patient.identityStatus === 'failed') throw new BusinessRuleError("We couldn't match your ID. Contact support and they'll help you finish.", 'identity_check_locked');
    await assertConsents(tx, patientId, 'identity_check');
    return patient;
  });

  const result = await gateway.checkDocument({ givenName: before.givenName, familyName: before.familyName, dateOfBirth: before.dateOfBirth, document });

  const outcome = await withTenant(context, async (tx) => {
    const patient = await lockPatient(tx, patientId);
    if (!sameLegal(patient, before)) throw new BusinessRuleError('Your details changed during the check. Try again.', 'details_changed');
    const [row] = await tx.db
      .insert(identityChecks)
      .values({ tenantId: context.tenantId, patientId, method: 'document', documentType, outcome: result.outcome, providerReference: result.reference })
      .returning({ id: identityChecks.id });
    await audit(tx, { action: 'patient.identity_checked', zone: 'clinical', recordTable: CHECKS, recordId: row!.id, details: { patientId, method: 'document', documentType, outcome: result.outcome } });
    if (patient.identityStatus !== 'unverified') return result.outcome;
    if (result.outcome === 'verified') await verified(tx, patientId, 'document', documentType);
    if (result.outcome === 'not_matched') {
      const failures = Math.min(patient.identityFailures + 1, MAX_IDENTITY_FAILURES);
      const failed = failures >= MAX_IDENTITY_FAILURES;
      await setIdentity(tx, patientId, { identityFailures: failures, ...(failed ? { identityStatus: 'failed' } : {}) });
      if (failed) await emitEvent(tx, { type: 'patient.identity_failed', recordTable: RECORD, recordId: patientId, payload: { attempts: failures } });
    }
    return result.outcome;
  });
  if (outcome === 'verified') await refreshIhi(context, patientId);
  return withTenant(context, (tx) => identityState(tx, patientId));
}

function assertPerson(tx: TenantTx): string {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a staff member can do this', 'person_only');
  return tx.context.actor.userId;
}

/** Staff sighted the document themselves (IDN17): a person with patients:verify_identity and a reason, never an agent. */
export async function verifyIdentityManually(context: TenantContext, patientId: string, input: { documentType: IdentityDocument; reason: string }): Promise<IdentityState> {
  await withTenant(context, async (tx) => {
    const userId = assertPerson(tx);
    const patient = await lockPatient(tx, patientId);
    if (patient.identityStatus === 'verified') throw new BusinessRuleError('This patient’s identity is already verified', 'already_verified');
    const [row] = await tx.db
      .insert(identityChecks)
      .values({ tenantId: context.tenantId, patientId, method: 'manual', documentType: input.documentType, outcome: 'verified', checkedBy: userId, reason: input.reason })
      .returning({ id: identityChecks.id });
    await audit(tx, { action: 'patient.identity_checked', zone: 'clinical', recordTable: CHECKS, recordId: row!.id, details: { patientId, method: 'manual', documentType: input.documentType, outcome: 'verified' } });
    await verified(tx, patientId, 'manual', input.documentType);
  });
  await refreshIhi(context, patientId);
  return withTenant(context, (tx) => identityState(tx, patientId));
}

/** Support lets a patient whose checks didn't match try again (IDN16). */
export async function reopenIdentityChecks(tx: TenantTx, patientId: string, reason: string): Promise<void> {
  assertPerson(tx);
  const patient = await lockPatient(tx, patientId);
  if (patient.identityStatus !== 'failed') throw new BusinessRuleError('Online checks are only reopened after three that didn’t match', 'not_failed');
  await setIdentity(tx, patientId, { identityStatus: 'unverified', identityFailures: 0 });
  await audit(tx, { action: 'patient.identity_reopened', zone: 'clinical', recordTable: RECORD, recordId: patientId, details: { reason } });
}

/**
 * Support corrects a legal detail (IDN6, IDN16): with a reason, and the
 * identity has to be checked again, so the old check and IHI no longer stand.
 */
export async function correctLegalDetails(tx: TenantTx, patientId: string, change: Partial<Legal>, reason: string): Promise<void> {
  assertPerson(tx);
  const patient = await lockPatient(tx, patientId);
  if (change.dateOfBirth !== undefined) await assertDateOfBirth(tx, change.dateOfBirth);
  const fields = (Object.keys(legalColumns) as (keyof Legal)[]).filter((field) => change[field] !== undefined && change[field] !== patient[field]);
  if (fields.length === 0) return;
  const set: Partial<typeof patients.$inferInsert> = {};
  for (const field of fields) Object.assign(set, { [field]: change[field] });
  const reset = patient.identityStatus !== 'unverified' || patient.identityFailures > 0;
  if (reset) Object.assign(set, { identityStatus: 'unverified', identityFailures: 0 });
  Object.assign(set, { ihi: null, ihiStatus: null, ihiRecordStatus: null, ihiCheckedAt: null });
  await setIdentity(tx, patientId, set);
  const changed = reset ? [...fields, 'identityStatus'] : fields;
  await audit(tx, { action: 'patient.legal_details_corrected', zone: 'clinical', recordTable: RECORD, recordId: patientId, details: { fields: changed.join(','), reason } });
  await emitEvent(tx, { type: 'patient.updated', recordTable: RECORD, recordId: patientId, payload: { fields: changed } });
}

export type IhiLookup = 'off' | 'not_verified' | 'unavailable' | 'found' | 'not_found';

/**
 * Look up the IHI for a verified patient (IDN19). Not finding one never
 * blocks care; the service being down leaves the last answer as it was.
 */
export async function refreshIhi(context: TenantContext, patientId: string): Promise<IhiLookup> {
  const service = hiService();
  if (!service) return 'off';
  const before = await withTenant(context, async (tx) => {
    const patient = await lockPatient(tx, patientId);
    if (patient.identityStatus !== 'verified') return null;
    const opened = await decryptOptional(tx, MEDICARE_PURPOSE, patient.medicare);
    const medicare = opened ? (JSON.parse(opened) as MedicareInput) : null;
    return { ...patient, medicare: medicare ? { number: medicare.number, irn: medicare.irn } : null };
  });
  if (!before) return 'not_verified';
  const result = await service.findIhi({ tenantId: context.tenantId }, before);
  if (result.outcome === 'unavailable') return 'unavailable';
  return withTenant(context, async (tx) => {
    const patient = await lockPatient(tx, patientId);
    if (!sameLegal(patient, before) || patient.identityStatus !== 'verified') return 'not_verified';
    const found = result.outcome === 'found';
    await setIdentity(tx, patientId, {
      ihi: found ? await encryptField(tx, IHI_PURPOSE, result.ihi) : null,
      ihiStatus: found ? result.status : null,
      ihiRecordStatus: found ? result.recordStatus : null,
      ihiCheckedAt: new Date(),
    });
    await audit(tx, { action: 'patient.ihi_looked_up', zone: 'clinical', recordTable: RECORD, recordId: patientId, details: { outcome: result.outcome } });
    return result.outcome;
  });
}
