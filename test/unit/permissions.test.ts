import { describe, expect, it } from 'vitest';
import { type DataZone, ROLES } from '../../src/db/schema/values.js';
import {
  AGENT_FORBIDDEN_PERMISSIONS,
  assertCanChangeMembership,
  assertCanGrant,
  CLINICAL_ROLES,
  heldPermissions,
  needsBreakGlass,
  PERMISSION_ZONES,
  PERMISSIONS,
  type Permission,
  ROLE_PERMISSIONS,
  usablePermissions,
} from '../../src/lib/permissions.js';

const all = (role: (typeof ROLES)[number]) => heldPermissions({ role });
const owner = { userId: 'owner-1', role: 'owner', status: 'active', permissions: all('owner') } as const;
const member = (userId: string, role: (typeof ROLES)[number], status: 'active' | 'suspended' = 'active') =>
  ({ userId, role, status, permissions: all(role) }) as const;

describe('the permission registry (ADM2, ADM3)', () => {
  it('gives the owner every permission', () => {
    expect([...all('owner')].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('gives every starting role a permission list, and only known keys', () => {
    for (const role of ROLES) for (const key of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(key);
  });

  it('keeps clinical-zone permissions off the business roles', () => {
    for (const role of ['admin', 'finance', 'support', 'operations', 'marketing', 'compliance'] as const) {
      expect(ROLE_PERMISSIONS[role].filter((key) => PERMISSION_ZONES[key] === 'clinical')).toEqual([]);
    }
  });

  it('never lets an agent hold a permission that changes access (ADM4)', () => {
    for (const key of ['staff:manage', 'roles:manage'] as const) expect(AGENT_FORBIDDEN_PERMISSIONS.has(key)).toBe(true);
  });

  it('gives staff:manage and roles:manage only to the owner and the tenant admin', () => {
    for (const role of ROLES) {
      const expected = role === 'owner' || role === 'admin';
      expect(all(role).has('staff:manage')).toBe(expected);
      expect(all(role).has('roles:manage')).toBe(expected);
    }
  });
});

describe('clinical permissions need a clinical role or break-glass (ADM3)', () => {
  // Pretend staff:read opens the clinical zone, so the rule is tested before any module adds a real clinical key.
  const zones: Record<string, DataZone> = { ...PERMISSION_ZONES, 'staff:read': 'clinical' };

  it('withholds a clinical permission from a non-clinical role until break-glass is open', () => {
    expect(usablePermissions({ role: 'owner' }, false, zones).has('staff:read')).toBe(false);
    expect(usablePermissions({ role: 'owner' }, false, zones).has('staff:manage')).toBe(true);
    expect(usablePermissions({ role: 'owner' }, true, zones).has('staff:read')).toBe(true);
    expect(needsBreakGlass({ role: 'owner' }, zones)).toBe(true);
  });

  it('lets a clinical role use what it holds without break-glass', () => {
    expect(usablePermissions({ role: 'clinician' }, false, zones).has('staff:read')).toBe(true);
    expect(needsBreakGlass({ role: 'clinician' }, zones)).toBe(false);
  });

  it('follows a custom role copied from a clinical role', () => {
    const grant = (clinical: boolean) => ({ role: 'custom' as const, customPermissions: ['staff:read'], customClinical: clinical });
    expect(usablePermissions(grant(true), false, zones).has('staff:read')).toBe(true);
    expect(usablePermissions(grant(false), false, zones).has('staff:read')).toBe(false);
  });

  it('marks the clinical starting roles', () => {
    expect([...CLINICAL_ROLES].sort()).toEqual(['clinician', 'medical_director', 'prescriber']);
  });

  it('needs break-glass only for a role that holds a clinical key it is not clinical enough to use', () => {
    // agents:transcripts is clinical (docs/decisions/agents.md AGT4): the owner holds it, so the owner needs break-glass to read transcripts.
    const needing = ROLES.filter((role) => needsBreakGlass({ role }));
    expect(needing).toEqual(['owner']);
    expect(usablePermissions({ role: 'owner' }, false).has('agents:transcripts')).toBe(false);
    expect(usablePermissions({ role: 'owner' }, true).has('agents:transcripts')).toBe(true);
  });
});

describe('granting roles (ADR 0030, FND6)', () => {
  it('lets an owner grant any role', () => {
    for (const role of ROLES) expect(() => assertCanGrant(all('owner'), { permissions: all(role) })).not.toThrow();
  });

  it('refuses a role the actor does not fully hold', () => {
    expect(() => assertCanGrant(all('clinician'), { permissions: all('owner') })).toThrow(/every permission of that role/);
    expect(() => assertCanGrant(all('admin'), { permissions: all('medical_director') })).toThrow(/every permission/);
  });

  it('refuses changing your own membership', () => {
    expect(() =>
      assertCanChangeMembership({ actor: owner, target: owner, next: { ...member('owner-1', 'support') }, activeOwners: 2 }),
    ).toThrow(/your own role/);
  });

  it('keeps at least one active owner', () => {
    const otherOwner = member('owner-2', 'owner');
    expect(() =>
      assertCanChangeMembership({ actor: owner, target: otherOwner, next: { ...otherOwner, status: 'suspended' }, activeOwners: 1 }),
    ).toThrow(/at least one active owner/);
    expect(() =>
      assertCanChangeMembership({ actor: owner, target: otherOwner, next: member('owner-2', 'clinician'), activeOwners: 2 }),
    ).not.toThrow();
  });

  it('refuses a suspended actor', () => {
    const clinician = member('c-1', 'clinician');
    expect(() =>
      assertCanChangeMembership({ actor: { ...owner, status: 'suspended' }, target: clinician, next: member('c-1', 'support'), activeOwners: 1 }),
    ).toThrow();
  });

  it('measures a custom role by its own permissions', () => {
    const permissions = new Set<Permission>(['staff:read', 'staff:manage']);
    expect(heldPermissions({ role: 'custom', customPermissions: ['staff:read', 'staff:manage', 'gone:key'] })).toEqual(permissions);
  });
});
