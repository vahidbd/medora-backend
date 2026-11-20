import { and, eq, gt, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { clinicianCredentials } from '../../db/schema/index.js';
import type { Profession } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { AddCredential, ClinicianDetail } from './clinicians.schemas.js';
import { getClinician } from './clinicians.service.js';
import { type Acting, type ClinicianRow, type CredentialRow, assertManagerOfAnother, assertSelfOrManager, clinicianById } from './clinicians.store.js';

/**
 * Registrations, endorsements and indemnity (docs/decisions/workforce.md
 * WRK1, WRK2, WRK4). The clinician or a manager records one; someone else
 * who manages clinicians checks it against the register or the policy.
 * Nothing is rewritten: a renewal is a new row, and verifying it withdraws
 * the one it replaces.
 */

const record = (clinicianId: string) => ({ recordTable: 'operational.clinicians', recordId: clinicianId }) as const;

/** WRK1: which body registers each profession. A health coach holds no registration. */
const REGISTERED_BY: Record<Profession, 'ahpra' | 'dietitians_australia' | null> = {
  medical_practitioner: 'ahpra',
  nurse_practitioner: 'ahpra',
  registered_nurse: 'ahpra',
  pharmacist: 'ahpra',
  psychologist: 'ahpra',
  dietitian: 'dietitians_australia',
  health_coach: null,
};

function assertFitsProfession(clinician: ClinicianRow, body: AddCredential): void {
  if (body.kind === 'registration') {
    const registeredBy = REGISTERED_BY[clinician.profession];
    if (registeredBy === null) throw new BadRequestError("This clinician's profession isn't registered", 'not_a_registered_profession');
    if (body.registeringBody !== registeredBy) throw new BadRequestError("That body doesn't register this profession", 'wrong_registering_body');
  }
  if (body.kind === 'endorsement' && clinician.profession !== 'nurse_practitioner') {
    throw new BadRequestError('Only a nurse practitioner holds this endorsement', 'endorsement_not_for_profession');
  }
}

export async function addCredential(tx: TenantTx, clinicianId: string, body: AddCredential, acting: Acting): Promise<ClinicianDetail> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertSelfOrManager(acting, clinician);
  assertFitsProfession(clinician, body);
  const [created] = await tx.db
    .insert(clinicianCredentials)
    .values({ tenantId: tx.context.tenantId, clinicianId, ...body, createdBy: acting.userId })
    .returning({ id: clinicianCredentials.id });
  if (!created) throw new Error('The credential was not saved');
  const facts = { credentialId: created.id, kind: body.kind };
  await audit(tx, { action: 'credential.added', zone: 'operational', ...record(clinicianId), details: facts });
  await emitEvent(tx, { type: 'credential.added', ...record(clinicianId), payload: facts });
  return getClinician(tx, clinicianId, acting);
}

async function credentialOf(tx: TenantTx, clinicianId: string, credentialId: string): Promise<CredentialRow> {
  const [row] = await tx.db
    .select()
    .from(clinicianCredentials)
    .where(
      and(
        eq(clinicianCredentials.tenantId, tx.context.tenantId),
        eq(clinicianCredentials.clinicianId, clinicianId),
        eq(clinicianCredentials.id, credentialId),
      ),
    );
  if (!row) throw new NotFoundError('Credential');
  return row;
}

const sameKind = (tx: TenantTx, credential: CredentialRow) =>
  and(
    eq(clinicianCredentials.tenantId, tx.context.tenantId),
    eq(clinicianCredentials.clinicianId, credential.clinicianId),
    eq(clinicianCredentials.kind, credential.kind),
    credential.endorsement === null ? isNull(clinicianCredentials.endorsement) : eq(clinicianCredentials.endorsement, credential.endorsement),
    ne(clinicianCredentials.id, credential.id),
    isNull(clinicianCredentials.withdrawnAt),
  );

/**
 * WRK2, WRK5: record that someone checked this credential today. Checking
 * it again is the re-check that clears "re-check due". The first check of a
 * renewal withdraws the older ones of its kind as replaced.
 */
export async function verifyCredential(tx: TenantTx, clinicianId: string, credentialId: string, acting: Acting): Promise<ClinicianDetail> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertManagerOfAnother(acting, clinician, 'check your credentials');
  const credential = await credentialOf(tx, clinicianId, credentialId);
  if (credential.withdrawnAt) throw new BusinessRuleError('This credential has been withdrawn', 'credential_withdrawn');
  const [newer] = await tx.db
    .select({ id: clinicianCredentials.id })
    .from(clinicianCredentials)
    .where(and(sameKind(tx, credential), gt(clinicianCredentials.createdAt, credential.createdAt), isNotNull(clinicianCredentials.verifiedAt)));
  if (newer) throw new BusinessRuleError('A newer credential of this kind is already checked', 'newer_credential_verified');
  const now = new Date();
  const recheck = credential.verifiedAt !== null;
  await tx.db
    .update(clinicianCredentials)
    .set({ verifiedAt: now, verifiedBy: acting.userId })
    .where(and(eq(clinicianCredentials.tenantId, tx.context.tenantId), eq(clinicianCredentials.id, credentialId)));
  const replaced = recheck
    ? []
    : await tx.db
        .update(clinicianCredentials)
        .set({ withdrawnAt: now, withdrawalReason: 'replaced' })
        .where(and(sameKind(tx, credential), lt(clinicianCredentials.createdAt, credential.createdAt)))
        .returning({ id: clinicianCredentials.id });
  const facts = { credentialId, kind: credential.kind, recheck, replaced: replaced.length };
  await audit(tx, { action: 'credential.verified', zone: 'operational', ...record(clinicianId), details: facts });
  await emitEvent(tx, { type: 'credential.verified', ...record(clinicianId), payload: { ...facts, replaced: replaced.map((r) => r.id) } });
  return getClinician(tx, clinicianId, acting);
}

/** WRK4: someone who manages clinicians, other than the clinician, has read the conditions on a registration. */
export async function reviewConditions(tx: TenantTx, clinicianId: string, credentialId: string, acting: Acting): Promise<ClinicianDetail> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertManagerOfAnother(acting, clinician, 'review the conditions on your registration');
  const credential = await credentialOf(tx, clinicianId, credentialId);
  if (credential.withdrawnAt) throw new BusinessRuleError('This credential has been withdrawn', 'credential_withdrawn');
  if (credential.kind !== 'registration' || !credential.conditions) {
    throw new BusinessRuleError('This credential has no conditions to review', 'no_conditions');
  }
  await tx.db
    .update(clinicianCredentials)
    .set({ conditionsReviewedAt: new Date(), conditionsReviewedBy: acting.userId })
    .where(and(eq(clinicianCredentials.tenantId, tx.context.tenantId), eq(clinicianCredentials.id, credentialId)));
  const facts = { credentialId };
  await audit(tx, { action: 'credential.conditions_reviewed', zone: 'operational', ...record(clinicianId), details: facts });
  await emitEvent(tx, { type: 'credential.conditions_reviewed', ...record(clinicianId), payload: facts });
  return getClinician(tx, clinicianId, acting);
}

/**
 * WRK2: a credential entered in error, or no longer held, is withdrawn,
 * never deleted. The clinician may withdraw their own while it is still
 * unchecked; once checked, a manager withdraws it.
 */
export async function withdrawCredential(
  tx: TenantTx,
  clinicianId: string,
  credentialId: string,
  reason: 'entered_in_error' | 'no_longer_held',
  acting: Acting,
): Promise<ClinicianDetail> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertSelfOrManager(acting, clinician);
  const credential = await credentialOf(tx, clinicianId, credentialId);
  if (credential.withdrawnAt) throw new BusinessRuleError('This credential is already withdrawn', 'credential_withdrawn');
  if (!acting.canManage && credential.verifiedAt) {
    throw new ForbiddenError('Ask someone who manages clinicians to withdraw a checked credential', 'credential_verified');
  }
  await tx.db
    .update(clinicianCredentials)
    .set({ withdrawnAt: new Date(), withdrawalReason: reason })
    .where(and(eq(clinicianCredentials.tenantId, tx.context.tenantId), eq(clinicianCredentials.id, credentialId)));
  const facts = { credentialId, kind: credential.kind, reason };
  await audit(tx, { action: 'credential.withdrawn', zone: 'operational', ...record(clinicianId), details: facts });
  await emitEvent(tx, { type: 'credential.withdrawn', ...record(clinicianId), payload: facts });
  return getClinician(tx, clinicianId, acting);
}
