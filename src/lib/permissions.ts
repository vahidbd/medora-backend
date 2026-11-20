import type { MembershipStatus, Role } from '../db/schema/values.js';
import { BusinessRuleError, ForbiddenError } from './errors.js';

/**
 * What each role may do, and the rules for changing who holds which role
 * (ADR 0030, docs/decisions/foundation.md FND3 and FND6). Roles are a
 * constant for now; a tenant editing its own roles is a later decision.
 */
export const PERMISSIONS = [
  'staff:read',
  'staff:manage',
  'ledger:read',
  'payment_accounts:manage',
  'prices:manage',
  'subscriptions:read',
  'subscriptions:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ['staff:read', 'staff:manage', 'ledger:read', 'payment_accounts:manage', 'prices:manage', 'subscriptions:read', 'subscriptions:manage'],
  clinician: ['staff:read'],
  support: ['staff:read', 'subscriptions:read', 'subscriptions:manage'],
  finance: ['staff:read', 'ledger:read', 'payment_accounts:manage', 'prices:manage', 'subscriptions:read', 'subscriptions:manage'],
};

/** The role that holds every permission. Every tenant always has at least one active holder. */
export const FULL_ACCESS_ROLE: Role = 'owner';

export function permissionsOf(role: Role): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

/** Only someone who holds every permission of a role may give it, or take it away. */
export function assertCanGrant(actorRole: Role, role: Role): void {
  const held = permissionsOf(actorRole);
  const missing = ROLE_PERMISSIONS[role].filter((permission) => !held.has(permission));
  if (missing.length > 0) throw new ForbiddenError(`Only someone with every permission of the ${role} role can give or remove it`);
}

export interface MembershipChange {
  actor: { userId: string; role: Role; status: MembershipStatus };
  target: { userId: string; role: Role; status: MembershipStatus };
  next: { role: Role; status: MembershipStatus };
  /** Active owners in the tenant now, counted under lock by the caller. */
  activeOwners: number;
}

export function assertCanChangeMembership({ actor, target, next, activeOwners }: MembershipChange): void {
  if (actor.status !== 'active') throw new ForbiddenError();
  if (actor.userId === target.userId) {
    throw new ForbiddenError("You can't change your own role or access. Ask another owner.", 'own_membership');
  }
  assertCanGrant(actor.role, target.role);
  assertCanGrant(actor.role, next.role);
  const wasActiveOwner = target.role === FULL_ACCESS_ROLE && target.status === 'active';
  const staysActiveOwner = next.role === FULL_ACCESS_ROLE && next.status === 'active';
  if (wasActiveOwner && !staysActiveOwner && activeOwners <= 1) {
    throw new BusinessRuleError('Every tenant needs at least one active owner', 'last_owner');
  }
}
