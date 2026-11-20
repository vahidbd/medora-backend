import { and, desc, eq, sql } from 'drizzle-orm';
import { memberships, roles, signIns, users } from '../../db/schema/index.js';
import type { MembershipRole, MembershipStatus } from '../../db/schema/values.js';
import type { DbTx, TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { assertCanChangeMembership, assertCanGrant, FULL_ACCESS_ROLE, heldPermissions, type Permission } from '../../lib/permissions.js';
import type { InvitationInput, MembershipChange, StaffMember } from './staff.schemas.js';

/** An invitation can be accepted for this long after it was last sent (docs/decisions/admin.md ADM5). The SQL in platform.accept_invitations says the same. */
export const INVITATION_DAYS = 14;

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

const memberColumns = {
  membershipId: memberships.id,
  userId: memberships.userId,
  email: users.email,
  displayName: users.displayName,
  role: memberships.role,
  customRoleId: memberships.customRoleId,
  customRoleName: roles.name,
  status: memberships.status,
  invitedAt: memberships.invitedAt,
  expiresAt: memberships.expiresAt,
  lastSignInAt: sql<Date | string | null>`(select max(s.at) from platform.sign_ins s where s.user_id = ${memberships.userId})`,
};

type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  customRoleId: string | null;
  customRoleName: string | null;
  status: string;
  invitedAt: Date | null;
  expiresAt: Date | null;
  lastSignInAt: Date | string | null;
};

function toStaffMember(row: MemberRow): StaffMember {
  const invitedAt = iso(row.invitedAt);
  const status = row.status as MembershipStatus;
  return {
    membershipId: row.membershipId,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    role: row.role as MembershipRole,
    customRole: row.customRoleId ? { id: row.customRoleId, name: row.customRoleName ?? '' } : null,
    status,
    invitedAt: status === 'invited' ? invitedAt : null,
    invitationExpiresAt:
      status === 'invited' && row.invitedAt ? new Date(row.invitedAt.getTime() + INVITATION_DAYS * 86_400_000).toISOString() : null,
    expiresAt: iso(row.expiresAt),
    lastSignInAt: iso(row.lastSignInAt),
  };
}

function memberQuery(tx: TenantTx) {
  return tx.db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(roles, and(eq(roles.tenantId, memberships.tenantId), eq(roles.id, memberships.customRoleId)));
}

export async function listStaff(tx: TenantTx): Promise<StaffMember[]> {
  const rows = await memberQuery(tx).where(eq(memberships.tenantId, tx.context.tenantId)).orderBy(users.email);
  return rows.map(toStaffMember);
}

async function findMember(tx: TenantTx, membershipId: string): Promise<StaffMember> {
  const [row] = await memberQuery(tx).where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.id, membershipId)));
  if (!row) throw new NotFoundError('Staff member');
  return toStaffMember(row);
}

export interface ResolvedRole {
  role: MembershipRole;
  customRoleId: string | null;
  permissions: ReadonlySet<Permission>;
}

/** A role someone may be given: a starting role, or one of this tenant's custom roles (ADM1). */
export async function resolveRole(tx: TenantTx, role: MembershipRole, customRoleId: string | null | undefined): Promise<ResolvedRole> {
  if (role !== 'custom') {
    if (customRoleId) throw new BadRequestError('A custom role id goes only with the custom role', 'custom_role_mismatch');
    return { role, customRoleId: null, permissions: heldPermissions({ role }) };
  }
  if (!customRoleId) throw new BadRequestError('Choose which custom role', 'custom_role_required');
  const [row] = await tx.db
    .select({ permissions: roles.permissions, clinical: roles.clinical })
    .from(roles)
    .where(and(eq(roles.tenantId, tx.context.tenantId), eq(roles.id, customRoleId)));
  if (!row) throw new NotFoundError('Role');
  return { role, customRoleId, permissions: heldPermissions({ role, customPermissions: row.permissions }) };
}

function personOf(tx: TenantTx): string {
  // docs/decisions/admin.md ADM4: who may do what is a person's decision, never an agent's (PRD ADM-07).
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person can change who has access', 'person_only');
  return tx.context.actor.userId;
}

/** The acting person's own role, read inside this transaction: what granting is measured against (ADR 0030). */
async function actorGrant(tx: TenantTx, userId: string): Promise<{ status: MembershipStatus; permissions: ReadonlySet<Permission> }> {
  const [row] = await tx.db
    .select({ role: memberships.role, customRoleId: memberships.customRoleId, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.userId, userId)));
  if (!row) throw new ForbiddenError();
  const resolved = await resolveRole(tx, row.role as MembershipRole, row.customRoleId);
  return { status: row.status as MembershipStatus, permissions: resolved.permissions };
}

/**
 * Change a staff member's role, access or end date (FND6, ADM7). The
 * tenant's active owners are locked first, lowest id first, and the actor's
 * own membership is read again under that lock, so two owners changing each
 * other at once can't leave the tenant without an owner.
 */
export async function changeMembership(tx: TenantTx, membershipId: string, change: MembershipChange): Promise<StaffMember> {
  const { tenantId } = tx.context;
  const actorId = personOf(tx);

  const owners = await tx.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, FULL_ACCESS_ROLE), eq(memberships.status, 'active')))
    .orderBy(memberships.id)
    .for('update');
  const [locked] = await tx.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)))
    .for('update');
  if (!locked) throw new NotFoundError('Staff member');
  const target = await findMember(tx, membershipId);
  const actor = await actorGrant(tx, actorId);

  if (target.status === 'invited' && change.status !== undefined) {
    throw new BusinessRuleError('This person hasn’t accepted their invitation yet. Resend or withdraw it instead.', 'still_invited');
  }
  const current = await resolveRole(tx, target.role, target.customRole?.id);
  const roleChanging = change.role !== undefined && (change.role !== target.role || (change.customRoleId ?? null) !== (target.customRole?.id ?? null));
  const next = roleChanging ? await resolveRole(tx, change.role!, change.customRoleId) : current;
  const nextStatus = change.status ?? target.status;
  const nextExpiresAt = change.expiresAt === undefined ? target.expiresAt : change.expiresAt === null ? null : new Date(change.expiresAt).toISOString();
  const expiresChanging = nextExpiresAt !== target.expiresAt;
  if (!roleChanging && nextStatus === target.status && !expiresChanging) return target;

  assertCanChangeMembership({
    actor: { userId: actorId, status: actor.status, permissions: actor.permissions },
    target: { userId: target.userId, role: target.role, status: target.status, permissions: current.permissions },
    next: { role: next.role, status: nextStatus, permissions: next.permissions },
    activeOwners: owners.length,
  });

  await tx.db
    .update(memberships)
    .set({
      role: next.role,
      customRoleId: next.customRoleId,
      status: nextStatus,
      expiresAt: nextExpiresAt === null ? null : new Date(nextExpiresAt),
      updatedAt: new Date(),
    })
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));

  const record = { recordTable: 'platform.memberships', recordId: membershipId } as const;
  if (roleChanging) {
    const facts = { from: target.role, to: next.role, fromCustomRoleId: target.customRole?.id ?? null, toCustomRoleId: next.customRoleId };
    await audit(tx, { action: 'membership.role_changed', zone: 'platform', ...record, details: facts });
    await emitEvent(tx, { type: 'membership.role_changed', ...record, payload: { ...facts, userId: target.userId } });
  }
  if (nextStatus !== target.status) {
    const facts = { from: target.status, to: nextStatus };
    await audit(tx, { action: 'membership.status_changed', zone: 'platform', ...record, details: facts });
    await emitEvent(tx, { type: 'membership.status_changed', ...record, payload: { ...facts, userId: target.userId } });
  }
  if (expiresChanging) {
    const facts = { from: target.expiresAt, to: nextExpiresAt };
    await audit(tx, { action: 'membership.expiry_changed', zone: 'platform', ...record, details: facts });
    await emitEvent(tx, { type: 'membership.expiry_changed', ...record, payload: { ...facts, userId: target.userId } });
  }
  return findMember(tx, membershipId);
}

/**
 * Invite someone (ADM5): their account is found or made by email, and an
 * invited membership is added, or an open invitation is renewed with the
 * role given. The reply is the same whether or not the email already had a
 * Medora account. The email itself is sent by the caller after commit.
 */
export async function inviteStaff(tx: TenantTx, input: InvitationInput): Promise<StaffMember> {
  const { tenantId } = tx.context;
  const actorId = personOf(tx);
  const actor = await actorGrant(tx, actorId);
  if (actor.status !== 'active') throw new ForbiddenError();
  const role = await resolveRole(tx, input.role, input.customRoleId);
  assertCanGrant(actor.permissions, { permissions: role.permissions });

  const person = await tx.db.execute<{ id: string }>(sql`select platform.invite_person(${input.email}, ${input.displayName ?? null}) as id`);
  const userId = person.rows[0]?.id;
  if (!userId) throw new Error('invite_person returned no account');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  const now = new Date();

  const [existing] = await tx.db
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
    .for('update');
  let membershipId: string;
  if (existing && existing.status !== 'invited') {
    throw new BusinessRuleError('That person already has access here. Change their role instead.', 'already_member');
  } else if (existing) {
    membershipId = existing.id;
    await tx.db
      .update(memberships)
      .set({ role: role.role, customRoleId: role.customRoleId, invitedAt: now, invitedBy: actorId, expiresAt, updatedAt: now })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
  } else {
    const [row] = await tx.db
      .insert(memberships)
      .values({ tenantId, userId, role: role.role, customRoleId: role.customRoleId, status: 'invited', invitedAt: now, invitedBy: actorId, expiresAt })
      .returning({ id: memberships.id });
    membershipId = row!.id;
  }
  const record = { recordTable: 'platform.memberships', recordId: membershipId } as const;
  const facts = { role: role.role, customRoleId: role.customRoleId, renewed: existing !== undefined };
  await audit(tx, { action: 'membership.invited', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'membership.invited', ...record, payload: { ...facts, userId } });
  return findMember(tx, membershipId);
}

async function openInvitation(tx: TenantTx, membershipId: string): Promise<StaffMember> {
  const member = await findMember(tx, membershipId);
  if (member.status !== 'invited') throw new BusinessRuleError('This person has already accepted their invitation', 'not_invited');
  return member;
}

/** Send the invitation again; it can be accepted for another 14 days (ADM5). */
export async function resendInvitation(tx: TenantTx, membershipId: string): Promise<StaffMember> {
  const actorId = personOf(tx);
  await openInvitation(tx, membershipId);
  const now = new Date();
  await tx.db
    .update(memberships)
    .set({ invitedAt: now, invitedBy: actorId, updatedAt: now })
    .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.id, membershipId)));
  const record = { recordTable: 'platform.memberships', recordId: membershipId } as const;
  await audit(tx, { action: 'membership.invitation_resent', zone: 'platform', ...record });
  await emitEvent(tx, { type: 'membership.invitation_resent', ...record });
  return findMember(tx, membershipId);
}

/** Withdraw an invitation nobody has accepted: the membership goes, and the link stops working (ADM5). */
export async function withdrawInvitation(tx: TenantTx, membershipId: string): Promise<void> {
  personOf(tx);
  const member = await openInvitation(tx, membershipId);
  await tx.db.delete(memberships).where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.id, membershipId)));
  const record = { recordTable: 'platform.memberships', recordId: membershipId } as const;
  await audit(tx, { action: 'membership.invitation_withdrawn', zone: 'platform', ...record });
  await emitEvent(tx, { type: 'membership.invitation_withdrawn', ...record, payload: { userId: member.userId } });
}

/** A person's most recent sign-ins (ADM6). Row-level security lets a person read their own, and a tenant read its staff's. */
export async function signInsOf(db: DbTx, userId: string) {
  const rows = await db
    .select({ at: signIns.at, clientIp: signIns.clientIp, device: signIns.device, secondFactor: signIns.secondFactor })
    .from(signIns)
    .where(eq(signIns.userId, userId))
    .orderBy(desc(signIns.at))
    .limit(50);
  return { signIns: rows.map((row) => ({ ...row, at: row.at.toISOString() })) };
}
