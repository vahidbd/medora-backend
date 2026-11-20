import { and, eq } from 'drizzle-orm';
import { clinicians, memberships } from '../../db/schema/index.js';
import type { SuspensionReason } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { ClinicianDetail, ClinicianSummary, CreateClinician, UpdateClinician } from './clinicians.schemas.js';
import {
  type Acting,
  allClinicians,
  assertManagerOfAnother,
  clinicianById,
  clinicianByUserId,
  countingIds,
  credentialReplyOf,
  credentialsOf,
  summaryOf,
  tenantToday,
} from './clinicians.store.js';
import { hoursOf, upcomingTimeOff } from './schedule.service.js';
import { type Standing, standingOf } from './standing.js';

const record = (clinicianId: string) => ({ recordTable: 'operational.clinicians', recordId: clinicianId }) as const;

export async function listClinicians(tx: TenantTx, now = new Date()): Promise<ClinicianSummary[]> {
  const rows = await allClinicians(tx);
  const credentials = await credentialsOf(tx, rows.map((r) => r.clinicianId));
  const today = await tenantToday(tx, now);
  return rows.map((row) => summaryOf(row, credentials.filter((c) => c.clinicianId === row.clinicianId), today, now));
}

export async function getClinician(tx: TenantTx, clinicianId: string, acting: Acting, now = new Date()): Promise<ClinicianDetail> {
  const row = await clinicianById(tx, clinicianId);
  const credentials = await credentialsOf(tx, [clinicianId]);
  const summary = summaryOf(row, credentials, await tenantToday(tx, now), now);
  const counting = countingIds(credentials);
  // docs/decisions/workforce.md WRK4: registration numbers and conditions are for managers and the clinician only.
  const mayReadCredentials = acting.canManage || acting.userId === row.userId;
  return {
    ...summary,
    credentials: mayReadCredentials ? credentials.map((c) => credentialReplyOf(c, counting.has(c.id))).reverse() : null,
    hours: await hoursOf(tx, clinicianId),
    timeOff: await upcomingTimeOff(tx, clinicianId, now),
  };
}

export async function createClinician(tx: TenantTx, body: CreateClinician, acting: Acting): Promise<ClinicianDetail> {
  const [membership] = await tx.db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.id, body.membershipId)));
  if (!membership) throw new NotFoundError('Staff member');
  if (membership.status !== 'active') throw new BusinessRuleError("That staff member's access is paused", 'membership_inactive');
  const [existing] = await tx.db.select({ id: clinicians.id }).from(clinicians).where(eq(clinicians.membershipId, body.membershipId));
  if (existing) throw new BusinessRuleError('That staff member is already a clinician', 'already_a_clinician');
  const [created] = await tx.db
    .insert(clinicians)
    .values({ tenantId: tx.context.tenantId, membershipId: body.membershipId, profession: body.profession, timeZone: body.timeZone })
    .returning({ id: clinicians.id });
  if (!created) throw new Error('The clinician was not created');
  await audit(tx, { action: 'clinician.created', zone: 'operational', ...record(created.id), details: { profession: body.profession } });
  await emitEvent(tx, { type: 'clinician.created', ...record(created.id), payload: { membershipId: body.membershipId, profession: body.profession } });
  return getClinician(tx, created.id, acting);
}

export async function updateClinician(tx: TenantTx, clinicianId: string, body: UpdateClinician, acting: Acting): Promise<ClinicianDetail> {
  const row = await clinicianById(tx, clinicianId, { lock: true });
  assertManagerOfAnother(acting, row, 'change your profession or time zone');
  const next = { profession: body.profession ?? row.profession, timeZone: body.timeZone ?? row.timeZone };
  if (next.profession !== row.profession || next.timeZone !== row.timeZone) {
    await tx.db
      .update(clinicians)
      .set({ ...next, updatedAt: new Date() })
      .where(and(eq(clinicians.tenantId, tx.context.tenantId), eq(clinicians.id, clinicianId)));
    const facts = { fromProfession: row.profession, toProfession: next.profession, timeZoneChanged: next.timeZone !== row.timeZone };
    await audit(tx, { action: 'clinician.updated', zone: 'operational', ...record(clinicianId), details: facts });
    await emitEvent(tx, { type: 'clinician.updated', ...record(clinicianId), payload: facts });
  }
  return getClinician(tx, clinicianId, acting);
}

/** WRK3: "suspend now" stops booking and starting consults at once, whatever the credentials say. */
export async function suspendClinician(tx: TenantTx, clinicianId: string, reason: SuspensionReason, acting: Acting): Promise<ClinicianDetail> {
  const row = await clinicianById(tx, clinicianId, { lock: true });
  assertManagerOfAnother(acting, row, 'suspend');
  if (row.suspendedAt) throw new BusinessRuleError('This clinician is already suspended', 'already_suspended');
  await tx.db
    .update(clinicians)
    .set({ suspendedAt: new Date(), suspensionReason: reason, suspendedBy: acting.userId, updatedAt: new Date() })
    .where(and(eq(clinicians.tenantId, tx.context.tenantId), eq(clinicians.id, clinicianId)));
  await audit(tx, { action: 'clinician.suspended', zone: 'operational', ...record(clinicianId), details: { reason } });
  await emitEvent(tx, { type: 'clinician.suspended', ...record(clinicianId), payload: { reason, userId: row.userId } });
  return getClinician(tx, clinicianId, acting);
}

export async function resumeClinician(tx: TenantTx, clinicianId: string, acting: Acting): Promise<ClinicianDetail> {
  const row = await clinicianById(tx, clinicianId, { lock: true });
  assertManagerOfAnother(acting, row, 'lift a suspension');
  if (!row.suspendedAt) throw new BusinessRuleError("This clinician isn't suspended", 'not_suspended');
  await tx.db
    .update(clinicians)
    .set({ suspendedAt: null, suspensionReason: null, suspendedBy: null, updatedAt: new Date() })
    .where(and(eq(clinicians.tenantId, tx.context.tenantId), eq(clinicians.id, clinicianId)));
  await audit(tx, { action: 'clinician.resumed', zone: 'operational', ...record(clinicianId), details: { reason: row.suspensionReason } });
  await emitEvent(tx, { type: 'clinician.resumed', ...record(clinicianId), payload: { userId: row.userId } });
  return getClinician(tx, clinicianId, acting);
}

/**
 * The front door's standing check (clinical-contracts.md section 3): may this
 * person consult, and may they prescribe, at `at`. Someone with no clinician
 * profile in the tenant may do neither.
 */
export async function clinicianStanding(tx: TenantTx, userId: string, at = new Date()): Promise<Standing> {
  const row = await clinicianByUserId(tx, userId);
  if (!row) return standingOf({ membershipActive: false, clinician: null, credentials: [], today: '', now: at });
  return summaryOf(row, await credentialsOf(tx, [row.clinicianId]), await tenantToday(tx, at), at).standing;
}

/** The clinician id for a person, for routes that act on "my" record. */
export async function clinicianIdOf(tx: TenantTx, userId: string): Promise<string> {
  const row = await clinicianByUserId(tx, userId);
  if (!row) throw new ForbiddenError("You don't have a clinician profile here", 'no_clinician_profile');
  return row.clinicianId;
}
