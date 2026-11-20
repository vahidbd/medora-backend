import { and, eq } from 'drizzle-orm';
import { memberships, users } from '../../db/schema/index.js';
import type { MembershipStatus, Role } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { assertCanChangeMembership } from '../../lib/permissions.js';
import type { MembershipChange, StaffMember } from './staff.schemas.js';

const memberColumns = {
  membershipId: memberships.id,
  userId: memberships.userId,
  email: users.email,
  role: memberships.role,
  status: memberships.status,
};

type MemberRow = { membershipId: string; userId: string; email: string; role: string; status: string };

function toStaffMember(row: MemberRow): StaffMember {
  return { ...row, role: row.role as Role, status: row.status as MembershipStatus };
}

export async function listStaff(tx: TenantTx): Promise<StaffMember[]> {
  const rows = await tx.db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tx.context.tenantId))
    .orderBy(users.email);
  return rows.map(toStaffMember);
}

/**
 * Change a staff member's role or access (docs/decisions/foundation.md FND6).
 * The tenant's active owners are locked first, lowest id first, and the
 * actor's own membership is read again under that lock, so two owners
 * changing each other at once can't leave the tenant without an owner.
 */
export async function changeMembership(tx: TenantTx, membershipId: string, change: MembershipChange): Promise<StaffMember> {
  const { tenantId, actor } = tx.context;
  if (actor.type !== 'person') throw new ForbiddenError();

  const owners = await tx.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
    .orderBy(memberships.id)
    .for('update');

  // Locked on its own: Postgres wants an unqualified name in FOR UPDATE OF, which a joined query here can't give.
  const [locked] = await tx.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)))
    .for('update');
  if (!locked) throw new NotFoundError('Staff member');
  const [targetRow] = await tx.db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));
  if (!targetRow) throw new NotFoundError('Staff member');
  const target = toStaffMember(targetRow);

  const [actorRow] = await tx.db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, actor.userId)));
  if (!actorRow) throw new ForbiddenError();

  const next = { role: change.role ?? target.role, status: change.status ?? target.status };
  if (next.role === target.role && next.status === target.status) return target;

  assertCanChangeMembership({
    actor: { userId: actor.userId, role: actorRow.role as Role, status: actorRow.status as MembershipStatus },
    target,
    next,
    activeOwners: owners.length,
  });

  await tx.db
    .update(memberships)
    .set({ role: next.role, status: next.status, updatedAt: new Date() })
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, membershipId)));

  const record = { recordTable: 'platform.memberships', recordId: membershipId } as const;
  if (next.role !== target.role) {
    const facts = { from: target.role, to: next.role };
    await audit(tx, { action: 'membership.role_changed', zone: 'platform', ...record, details: facts });
    await emitEvent(tx, { type: 'membership.role_changed', ...record, payload: { ...facts, userId: target.userId } });
  }
  if (next.status !== target.status) {
    const facts = { from: target.status, to: next.status };
    await audit(tx, { action: 'membership.status_changed', zone: 'platform', ...record, details: facts });
    await emitEvent(tx, { type: 'membership.status_changed', ...record, payload: { ...facts, userId: target.userId } });
  }
  return { ...target, ...next };
}
