import type { DataZone, MembershipRole, MembershipStatus, Role } from '../db/schema/values.js';
import { BusinessRuleError, ForbiddenError } from './errors.js';

/**
 * What each role may do, and the rules for changing who holds which role
 * (ADR 0030, docs/decisions/foundation.md FND6, docs/decisions/admin.md
 * ADM1 to ADM4).
 *
 * Every module adds its own keys here: to PERMISSIONS, to PERMISSION_ZONES
 * (the data zone the key opens) and to each starting role in
 * ROLE_PERMISSIONS that should hold it. The owner holds every key without
 * being listed. Code checks permissions, never role keys.
 */
export const PERMISSIONS = ['staff:read', 'staff:manage', 'roles:manage', 'break_glass:review'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The data zone each permission opens (ADR 0007). A clinical one works only
 * for a clinical role, or under break-glass (ADM3). A Record, so a key
 * without a zone fails the type check.
 */
export const PERMISSION_ZONES: Record<Permission, DataZone> = {
  'staff:read': 'platform',
  'staff:manage': 'platform',
  'roles:manage': 'platform',
  'break_glass:review': 'platform',
};

const ALL: readonly Permission[] = PERMISSIONS;

/** The starting roles' permissions (ADM2). Tenants can't edit these; they copy one into a custom role instead. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ['staff:read', 'staff:manage', 'roles:manage'],
  medical_director: ['staff:read', 'break_glass:review'],
  prescriber: ['staff:read'],
  clinician: ['staff:read'],
  support: ['staff:read'],
  finance: ['staff:read'],
  operations: ['staff:read'],
  marketing: ['staff:read'],
  compliance: ['staff:read'],
};

/** Starting roles that see patients clinically, so their clinical permissions work without break-glass (ADM3). */
export const CLINICAL_ROLES: ReadonlySet<Role> = new Set<Role>(['prescriber', 'clinician', 'medical_director']);

/** The role that holds every permission. Every tenant always has at least one active holder. */
export const FULL_ACCESS_ROLE: Role = 'owner';

/** Permissions no agent may ever use, whatever role it runs as (ADM4, PRD ADM-07). */
export const AGENT_FORBIDDEN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['staff:manage', 'roles:manage', 'break_glass:review']);

/** How long break-glass lasts once opened (ADM3). */
export const BREAK_GLASS_MINUTES = 60;

const known = new Set<string>(PERMISSIONS);

/** A membership's role, as stored: a starting role, or a custom role's own permissions. */
export interface RoleGrant {
  role: MembershipRole;
  /** A custom role's stored permissions; ignored for starting roles. */
  customPermissions?: readonly string[] | null;
  /** A custom role copied from a clinical role; ignored for starting roles. */
  customClinical?: boolean | null;
}

/** Every permission the role holds, usable or not. Granting is measured against this. */
export function heldPermissions(grant: RoleGrant): ReadonlySet<Permission> {
  if (grant.role === 'custom') return new Set((grant.customPermissions ?? []).filter((key): key is Permission => known.has(key)));
  return new Set(ROLE_PERMISSIONS[grant.role]);
}

export function isClinicalRole(grant: RoleGrant): boolean {
  return grant.role === 'custom' ? grant.customClinical === true : CLINICAL_ROLES.has(grant.role);
}

/**
 * The permissions a request may use (ADM3): everything the role holds,
 * except clinical-zone ones when the role isn't clinical and break-glass
 * isn't open.
 */
export function usablePermissions(
  grant: RoleGrant,
  breakGlassOpen: boolean,
  zones: Readonly<Record<string, DataZone>> = PERMISSION_ZONES,
): ReadonlySet<Permission> {
  const held = heldPermissions(grant);
  if (breakGlassOpen || isClinicalRole(grant)) return held;
  return new Set([...held].filter((key) => zones[key] !== 'clinical'));
}

/** Whether the role holds clinical permissions it can only use under break-glass. */
export function needsBreakGlass(grant: RoleGrant, zones: Readonly<Record<string, DataZone>> = PERMISSION_ZONES): boolean {
  return !isClinicalRole(grant) && [...heldPermissions(grant)].some((key) => zones[key] === 'clinical');
}

/** Only someone who holds every permission of a role may give it, or take it away (ADR 0030). */
export function assertCanGrant(actor: ReadonlySet<Permission>, role: { permissions: Iterable<Permission> }): void {
  const missing = [...role.permissions].filter((permission) => !actor.has(permission));
  if (missing.length > 0) throw new ForbiddenError('Only someone with every permission of that role can give or remove it', 'cannot_grant');
}

export interface MembershipChange {
  actor: { userId: string; status: MembershipStatus; permissions: ReadonlySet<Permission> };
  target: { userId: string; role: MembershipRole; status: MembershipStatus; permissions: ReadonlySet<Permission> };
  next: { role: MembershipRole; status: MembershipStatus; permissions: ReadonlySet<Permission> };
  /** Active owners in the tenant now, counted under lock by the caller. */
  activeOwners: number;
}

export function assertCanChangeMembership({ actor, target, next, activeOwners }: MembershipChange): void {
  if (actor.status !== 'active') throw new ForbiddenError();
  if (actor.userId === target.userId) {
    throw new ForbiddenError("You can't change your own role or access. Ask another owner.", 'own_membership');
  }
  assertCanGrant(actor.permissions, target);
  assertCanGrant(actor.permissions, next);
  const wasActiveOwner = target.role === FULL_ACCESS_ROLE && target.status === 'active';
  const staysActiveOwner = next.role === FULL_ACCESS_ROLE && next.status === 'active';
  if (wasActiveOwner && !staysActiveOwner && activeOwners <= 1) {
    throw new BusinessRuleError('Every tenant needs at least one active owner', 'last_owner');
  }
}
