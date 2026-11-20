import { describe, expect, it } from 'vitest';
import { assertCanChangeMembership, assertCanGrant, permissionsOf } from '../../src/lib/permissions.js';

const owner = { userId: 'owner-1', role: 'owner', status: 'active' } as const;

describe('granting roles (ADR 0030, FND6)', () => {
  it('lets an owner grant any role', () => {
    expect(() => assertCanGrant('owner', 'owner')).not.toThrow();
    expect(() => assertCanGrant('owner', 'clinician')).not.toThrow();
  });

  it('refuses a role the actor does not fully hold', () => {
    expect(() => assertCanGrant('clinician', 'owner')).toThrow(/every permission of the owner role/);
  });

  it('gives staff:manage to owners only', () => {
    expect(permissionsOf('owner').has('staff:manage')).toBe(true);
    for (const role of ['clinician', 'support', 'finance'] as const) expect(permissionsOf(role).has('staff:manage')).toBe(false);
  });

  it('refuses changing your own membership', () => {
    expect(() =>
      assertCanChangeMembership({ actor: owner, target: owner, next: { role: 'support', status: 'active' }, activeOwners: 2 }),
    ).toThrow(/your own role/);
  });

  it('keeps at least one active owner', () => {
    const otherOwner = { userId: 'owner-2', role: 'owner', status: 'active' } as const;
    expect(() =>
      assertCanChangeMembership({ actor: owner, target: otherOwner, next: { role: 'owner', status: 'suspended' }, activeOwners: 1 }),
    ).toThrow(/at least one active owner/);
    expect(() =>
      assertCanChangeMembership({ actor: owner, target: otherOwner, next: { role: 'clinician', status: 'active' }, activeOwners: 2 }),
    ).not.toThrow();
  });

  it('refuses a suspended actor', () => {
    const clinician = { userId: 'c-1', role: 'clinician', status: 'active' } as const;
    expect(() =>
      assertCanChangeMembership({ actor: { ...owner, status: 'suspended' }, target: clinician, next: { role: 'support', status: 'active' }, activeOwners: 1 }),
    ).toThrow();
  });
});
