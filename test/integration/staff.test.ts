import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createUser, tenantWith } from '../support/db.js';

/** Sign-in, tenant choice and changing roles (FND1 to FND3, FND6). */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

describe('signing in', () => {
  it('refuses a request without a token', async () => {
    const reply = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(reply.statusCode).toBe(401);
  });

  it('refuses a token signed with another secret', async () => {
    const reply = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad' } });
    expect(reply.statusCode).toBe(401);
  });

  it('links an invited account on first sign-in, by email, and audits it (FND2)', async () => {
    const { tenantId, members } = await tenantWith('clinician');
    const person = members[0]!;
    const reply = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(person.email, 'clerk_first')) });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ userId: person.id, memberships: [{ tenantId, role: 'clinician', status: 'active', permissions: ['staff:read', 'patients:read', 'clinicians:read'] }] });
    const { rows } = await admin.query('select clerk_user_id from platform.users where id = $1', [person.id]);
    expect(rows[0].clerk_user_id).toBe('clerk_first');
    const audit = await admin.query("select 1 from platform.audit_log where action = 'user.sign_in_linked' and record_id = $1", [person.id]);
    expect(audit.rowCount).toBe(1);
  });

  it("doesn't let a second sign-in take over a linked account", async () => {
    const person = await createUser();
    await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(person.email, 'clerk_owner_of_it')) });
    const reply = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(person.email, 'clerk_someone_else')) });
    expect(reply.statusCode).toBe(401);
    expect(reply.json().error.code).toBe('no_account');
  });

  it('refuses a sign-in nobody invited', async () => {
    const reply = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn('stranger@example.test')) });
    expect(reply.json().error.code).toBe('no_account');
  });
});

describe('choosing a tenant (FND1)', () => {
  it("refuses a tenant the person isn't a member of", async () => {
    const mine = await tenantWith('owner');
    const theirs = await tenantWith('owner');
    const token = await signIn(mine.members[0]!.email);
    const reply = await app.inject({ method: 'GET', url: '/v1/staff', headers: headers(token, theirs.tenantId) });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('not_a_member');
  });

  it('needs a tenant for a route that needs a permission', async () => {
    const { members } = await tenantWith('owner');
    const reply = await app.inject({ method: 'GET', url: '/v1/staff', headers: headers(await signIn(members[0]!.email)) });
    expect(reply.json().error.code).toBe('tenant_required');
  });

  it('refuses a suspended member', async () => {
    const { tenantId, members } = await tenantWith('owner', 'support');
    await admin.query("update platform.memberships set status = 'suspended' where id = $1", [members[1]!.membershipId]);
    const reply = await app.inject({ method: 'GET', url: '/v1/staff', headers: headers(await signIn(members[1]!.email), tenantId) });
    expect(reply.statusCode).toBe(403);
  });

  it("lists the tenant's staff, and only theirs", async () => {
    const { tenantId, members } = await tenantWith('owner', 'clinician');
    await tenantWith('owner');
    const reply = await app.inject({ method: 'GET', url: '/v1/staff', headers: headers(await signIn(members[1]!.email), tenantId) });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().staff.map((s: { userId: string }) => s.userId).sort()).toEqual(members.map((m) => m.id).sort());
  });
});

describe('changing a role (FND6)', () => {
  const change = async (actorEmail: string, tenantId: string, membershipId: string, body: object) =>
    app.inject({ method: 'PATCH', url: `/v1/staff/${membershipId}`, headers: headers(await signIn(actorEmail), tenantId), payload: body });

  it('lets an owner change a role, with an audit entry and an event in the same commit', async () => {
    const { tenantId, members } = await tenantWith('owner', 'clinician');
    const [owner, clinician] = members as [(typeof members)[0], (typeof members)[0]];
    const reply = await change(owner.email, tenantId, clinician.membershipId, { role: 'support' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ membershipId: clinician.membershipId, role: 'support' });
    const audit = await admin.query('select actor_id, details from platform.audit_log where tenant_id = $1 and action = $2', [tenantId, 'membership.role_changed']);
    expect(audit.rows).toEqual([{ actor_id: owner.id, details: { from: 'clinician', to: 'support', fromCustomRoleId: null, toCustomRoleId: null } }]);
    const events = await admin.query('select type from platform.outbox where tenant_id = $1', [tenantId]);
    expect(events.rows).toEqual([{ type: 'membership.role_changed' }]);
  });

  it("refuses anyone without staff:manage", async () => {
    const { tenantId, members } = await tenantWith('owner', 'clinician');
    const reply = await change(members[1]!.email, tenantId, members[0]!.membershipId, { role: 'support' });
    expect(reply.statusCode).toBe(403);
  });

  it('refuses changing your own role', async () => {
    const { tenantId, members } = await tenantWith('owner', 'owner');
    const reply = await change(members[0]!.email, tenantId, members[0]!.membershipId, { role: 'clinician' });
    expect(reply.json().error.code).toBe('own_membership');
  });

  it("can't reach a membership in another tenant", async () => {
    const mine = await tenantWith('owner');
    const theirs = await tenantWith('owner', 'clinician');
    const reply = await change(mine.members[0]!.email, mine.tenantId, theirs.members[1]!.membershipId, { role: 'support' });
    expect(reply.statusCode).toBe(404);
  });

  it('keeps an owner when two owners demote each other at the same moment', async () => {
    const { tenantId, members } = await tenantWith('owner', 'owner');
    const [a, b] = members as [(typeof members)[0], (typeof members)[0]];
    const replies = await Promise.all([
      change(a.email, tenantId, b.membershipId, { role: 'clinician' }),
      change(b.email, tenantId, a.membershipId, { role: 'clinician' }),
    ]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    const { rows } = await admin.query("select count(*)::int as owners from platform.memberships where tenant_id = $1 and role = 'owner' and status = 'active'", [tenantId]);
    expect(rows[0].owners).toBe(1);
  });

  it('refuses a body that changes nothing it knows', async () => {
    const { tenantId, members } = await tenantWith('owner', 'clinician');
    const reply = await change(members[0]!.email, tenantId, members[1]!.membershipId, { role: 'clinician', extra: 1 });
    expect(reply.statusCode).toBe(400);
  });
});
