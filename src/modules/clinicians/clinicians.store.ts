import { and, eq, inArray } from 'drizzle-orm';
import { clinicianCredentials, clinicians, memberships, tenants, users } from '../../db/schema/index.js';
import type { CredentialKind, CredentialWithdrawalReason, Endorsement, Profession, RegistrationStatus, RegisteringBody, RegistrationType, SuspensionReason } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { localDate } from '../../lib/time.js';
import type { ClinicianSummary, CredentialReply } from './clinicians.schemas.js';
import { type CredentialFacts, standingOf } from './standing.js';

/** Reading the workforce tables: the clinician with their membership, their credentials, and the tenant's "today". */

export interface ClinicianRow {
  clinicianId: string;
  membershipId: string;
  userId: string;
  email: string;
  membershipStatus: string;
  profession: Profession;
  timeZone: string;
  suspendedAt: Date | null;
  suspensionReason: SuspensionReason | null;
}

/** Who is acting, and whether they may manage every clinician (WRK4). */
export interface Acting {
  userId: string;
  canManage: boolean;
}

const clinicianColumns = {
  clinicianId: clinicians.id,
  membershipId: clinicians.membershipId,
  userId: memberships.userId,
  email: users.email,
  membershipStatus: memberships.status,
  profession: clinicians.profession,
  timeZone: clinicians.timeZone,
  suspendedAt: clinicians.suspendedAt,
  suspensionReason: clinicians.suspensionReason,
};

function baseQuery(tx: TenantTx) {
  return tx.db
    .select(clinicianColumns)
    .from(clinicians)
    .innerJoin(memberships, eq(memberships.id, clinicians.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId));
}

const asRow = (row: { profession: string; suspensionReason: string | null } & Omit<ClinicianRow, 'profession' | 'suspensionReason'>): ClinicianRow => ({
  ...row,
  profession: row.profession as Profession,
  suspensionReason: row.suspensionReason as SuspensionReason | null,
});

export async function allClinicians(tx: TenantTx): Promise<ClinicianRow[]> {
  return (await baseQuery(tx).where(eq(clinicians.tenantId, tx.context.tenantId)).orderBy(users.email)).map(asRow);
}

/** One clinician; with `lock`, their row is held until the transaction ends, so changes to them happen one at a time. */
export async function clinicianById(tx: TenantTx, clinicianId: string, options: { lock?: boolean } = {}): Promise<ClinicianRow> {
  if (options.lock) {
    const [locked] = await tx.db
      .select({ id: clinicians.id })
      .from(clinicians)
      .where(and(eq(clinicians.tenantId, tx.context.tenantId), eq(clinicians.id, clinicianId)))
      .for('update');
    if (!locked) throw new NotFoundError('Clinician');
  }
  const [row] = await baseQuery(tx).where(and(eq(clinicians.tenantId, tx.context.tenantId), eq(clinicians.id, clinicianId)));
  if (!row) throw new NotFoundError('Clinician');
  return asRow(row);
}

export async function clinicianByUserId(tx: TenantTx, userId: string): Promise<ClinicianRow | null> {
  const [row] = await baseQuery(tx).where(and(eq(clinicians.tenantId, tx.context.tenantId), eq(memberships.userId, userId)));
  return row ? asRow(row) : null;
}

/** How screens name each clinician, by user id: the name they were invited under, or null when none was given. */
export async function clinicianNames(tx: TenantTx, userIds: string[]): Promise<Map<string, string | null>> {
  if (userIds.length === 0) return new Map();
  const rows = await tx.db
    .select({ userId: memberships.userId, displayName: users.displayName })
    .from(clinicians)
    .innerJoin(memberships, eq(memberships.id, clinicians.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(clinicians.tenantId, tx.context.tenantId), inArray(memberships.userId, userIds)));
  return new Map(rows.map((row) => [row.userId, row.displayName]));
}

export type CredentialRow = typeof clinicianCredentials.$inferSelect;

export async function credentialsOf(tx: TenantTx, clinicianIds: string[]): Promise<CredentialRow[]> {
  if (clinicianIds.length === 0) return [];
  return tx.db
    .select()
    .from(clinicianCredentials)
    .where(and(eq(clinicianCredentials.tenantId, tx.context.tenantId), inArray(clinicianCredentials.clinicianId, clinicianIds)))
    .orderBy(clinicianCredentials.createdAt);
}

export async function tenantToday(tx: TenantTx, at: Date): Promise<string> {
  const [tenant] = await tx.db.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tx.context.tenantId));
  return localDate(at, tenant?.timeZone ?? 'Australia/Sydney');
}

export function factsOf(row: CredentialRow): CredentialFacts {
  return {
    kind: row.kind as CredentialKind,
    registrationStatus: row.registrationStatus as RegistrationStatus | null,
    conditions: row.conditions,
    conditionsReviewedAt: row.conditionsReviewedAt,
    endorsement: row.endorsement as Endorsement | null,
    coversTelehealthNewPatients: row.coversTelehealthNewPatients,
    expiresOn: row.expiresOn,
    verifiedAt: row.verifiedAt,
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
  };
}

export function summaryOf(row: ClinicianRow, credentials: CredentialRow[], today: string, now: Date): ClinicianSummary {
  return {
    clinicianId: row.clinicianId,
    membershipId: row.membershipId,
    userId: row.userId,
    email: row.email,
    profession: row.profession,
    timeZone: row.timeZone,
    suspension: row.suspendedAt && row.suspensionReason ? { at: row.suspendedAt.toISOString(), reason: row.suspensionReason } : null,
    standing: standingOf({
      membershipActive: row.membershipStatus === 'active',
      clinician: { profession: row.profession, suspendedAt: row.suspendedAt },
      credentials: credentials.map(factsOf),
      today,
      now,
    }),
  };
}

/** The ids of the credentials that count now: the newest verified one held, per kind (and per endorsement). */
export function countingIds(credentials: CredentialRow[]): Set<string> {
  const best = new Map<string, CredentialRow>();
  for (const credential of credentials) {
    if (credential.withdrawnAt || !credential.verifiedAt) continue;
    const key = `${credential.kind}:${credential.endorsement ?? ''}`;
    const held = best.get(key);
    if (!held || held.createdAt < credential.createdAt) best.set(key, credential);
  }
  return new Set([...best.values()].map((c) => c.id));
}

export function credentialReplyOf(row: CredentialRow, counts: boolean): CredentialReply {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return {
    credentialId: row.id,
    kind: row.kind as CredentialKind,
    reference: row.reference,
    registeringBody: row.registeringBody as RegisteringBody | null,
    registrationType: row.registrationType as RegistrationType | null,
    registrationStatus: row.registrationStatus as RegistrationStatus | null,
    conditions: row.conditions,
    endorsement: row.endorsement as Endorsement | null,
    insurer: row.insurer,
    coversTelehealthNewPatients: row.coversTelehealthNewPatients,
    startsOn: row.startsOn,
    expiresOn: row.expiresOn,
    verifiedAt: iso(row.verifiedAt),
    conditionsReviewedAt: iso(row.conditionsReviewedAt),
    withdrawnAt: iso(row.withdrawnAt),
    withdrawalReason: row.withdrawalReason as CredentialWithdrawalReason | null,
    createdAt: row.createdAt.toISOString(),
    counts,
  };
}

/** The clinician themselves, or someone who manages clinicians. */
export function assertSelfOrManager(acting: Acting, clinician: ClinicianRow): void {
  if (!acting.canManage && acting.userId !== clinician.userId) throw new ForbiddenError();
}

/** WRK4: someone who manages clinicians, and never about themselves. */
export function assertManagerOfAnother(acting: Acting, clinician: ClinicianRow, what: string): void {
  if (!acting.canManage) throw new ForbiddenError();
  if (acting.userId === clinician.userId) throw new ForbiddenError(`Someone else has to ${what} for you`, 'own_record');
}
