import { sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { breakGlass, roles, signIns } from '../../src/db/schema/index.js';
import { withTenant } from '../../src/db/tenant.js';
import { invitations } from '../../src/modules/staff/invitations.js';
import { inviteStaff } from '../../src/modules/staff/staff.service.js';
import { headers, signIn, testApp } from '../support/app.js';
import { addMember, admin, createCustomRole, createUser, tenantWith } from '../support/db.js';

/** Staff access: two-step sign-in, invitations, custom roles, sign-in history, break-glass (docs/decisions/admin.md ADM1 to ADM7). */
const app = await testApp();
const sent: string[] = [];
const send = vi.spyOn(invitations, 'send').mockImplementation(async (email) => {
  sent.push(email);
  return 'sent';
});
afterEach(() => {
  sent.length = 0;
});
afterAll(async () => {
  send.mockRestore();
  await app.close();
  await closeDatabase();
  await admin.end();
});

const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, email: string, tenantId: string, payload?: object) =>
  app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

describe('two-step sign-in (ADM6)', () => {
  it('refuses tenant routes to a session without a second factor, and says so on /me', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const token = await signIn(members[0]!.email, undefined, { secondFactor: false });
    const staff = await app.inject({ method: 'GET', url: '/v1/staff', headers: headers(token, tenantId) });
    expect(staff.statusCode).toBe(403);
    expect(staff.json().error.code).toBe('two_step_required');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(token) });
    expect(me.json().secondFactor).toBe(false);
  });
});

describe('invitations (ADM5)', () => {
  it('invites a new person, sends the email after commit, and activates them on first sign-in', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const email = `new-${crypto.randomUUID()}@example.test`;
    const reply = await call('POST', '/v1/staff/invitations', members[0]!.email, tenantId, { email, displayName: 'Made Up Person', role: 'clinician' });
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({ email: 'sent', member: { email, displayName: 'Made Up Person', role: 'clinician', status: 'invited' } });
    expect(sent).toEqual([email]);
    const audit = await admin.query("select details from platform.audit_log where tenant_id = $1 and action = 'membership.invited'", [tenantId]);
    expect(audit.rows).toEqual([{ details: { role: 'clinician', customRoleId: null, renewed: false } }]);

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(email)) });
    expect(me.json().memberships).toMatchObject([{ tenantId, status: 'active', role: 'clinician' }]);
    const accepted = await admin.query("select 1 from platform.audit_log where tenant_id = $1 and action = 'membership.invitation_accepted'", [tenantId]);
    expect(accepted.rowCount).toBe(1);
  });

  it("doesn't accept an invitation after 14 days, until it is sent again", async () => {
    const { tenantId, members } = await tenantWith('owner');
    const person = await createUser();
    const membershipId = await addMember(tenantId, person.id, 'support', 'invited');
    await admin.query("update platform.memberships set invited_at = now() - interval '15 days' where id = $1", [membershipId]);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(person.email)) });
    expect(me.json().memberships).toMatchObject([{ status: 'invited' }]);

    const resent = await call('POST', `/v1/staff/${membershipId}/invitation`, members[0]!.email, tenantId);
    expect(resent.json()).toMatchObject({ email: 'sent', member: { status: 'invited' } });
    const again = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(person.email)) });
    expect(again.json().memberships).toMatchObject([{ status: 'active' }]);
  });

  it('withdraws an invitation, and only one nobody has accepted', async () => {
    const { tenantId, members } = await tenantWith('owner', 'support');
    const person = await createUser();
    const membershipId = await addMember(tenantId, person.id, 'support', 'invited');
    const withdrawn = await call('DELETE', `/v1/staff/${membershipId}/invitation`, members[0]!.email, tenantId);
    expect(withdrawn.statusCode).toBe(200);
    expect((await admin.query('select 1 from platform.memberships where id = $1', [membershipId])).rowCount).toBe(0);
    const active = await call('DELETE', `/v1/staff/${members[1]!.membershipId}/invitation`, members[0]!.email, tenantId);
    expect(active.json().error.code).toBe('not_invited');
  });

  it('answers the same for an email another tenant knows, without renaming them', async () => {
    const other = await tenantWith('support');
    await admin.query("update platform.users set display_name = 'Their name' where id = $1", [other.members[0]!.id]);
    const { tenantId, members } = await tenantWith('owner');
    const reply = await call('POST', '/v1/staff/invitations', members[0]!.email, tenantId, { email: other.members[0]!.email, displayName: 'Another name', role: 'support' });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().member.displayName).toBe('Their name');
  });

  it('refuses someone already working here, a role the inviter cannot give, and anyone without staff:manage', async () => {
    const { tenantId, members } = await tenantWith('owner', 'admin', 'support');
    const [owner, adminMember, support] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];
    expect((await call('POST', '/v1/staff/invitations', owner.email, tenantId, { email: support.email, role: 'finance' })).json().error.code).toBe('already_member');
    expect((await call('POST', '/v1/staff/invitations', adminMember.email, tenantId, { email: 'x@example.test', role: 'owner' })).json().error.code).toBe('cannot_grant');
    expect((await call('POST', '/v1/staff/invitations', support.email, tenantId, { email: 'y@example.test', role: 'support' })).statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  it('refuses an agent, even inside the service (ADM4)', async () => {
    const { tenantId } = await tenantWith('owner');
    await expect(
      withTenant({ tenantId, actor: { type: 'agent', agentId: crypto.randomUUID(), runId: crypto.randomUUID(), approvedBy: null }, requestId: 'test' }, (tx) =>
        inviteStaff(tx, { email: 'z@example.test', role: 'support' }),
      ),
    ).rejects.toMatchObject({ code: 'person_only' });
  });
});

describe('time-limited access (ADM7)', () => {
  it('ends access at its end date', async () => {
    const { tenantId, members } = await tenantWith('owner', 'support');
    const set = await call('PATCH', `/v1/staff/${members[1]!.membershipId}`, members[0]!.email, tenantId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(set.statusCode).toBe(200);
    const reply = await call('GET', '/v1/staff', members[1]!.email, tenantId);
    expect(reply.json().error.code).toBe('not_a_member');
    const back = await call('PATCH', `/v1/staff/${members[1]!.membershipId}`, members[0]!.email, tenantId, { expiresAt: null });
    expect(back.json().expiresAt).toBeNull();
    expect((await call('GET', '/v1/staff', members[1]!.email, tenantId)).statusCode).toBe(200);
  });
});

describe('custom roles (ADM1, ADM4)', () => {
  it('lets an admin make a role, give it, and the holder gets exactly its permissions', async () => {
    const { tenantId, members } = await tenantWith('owner', 'admin', 'support');
    const [, adminMember, support] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];
    const made = await call('POST', '/v1/roles', adminMember.email, tenantId, { basedOn: 'support', name: 'Team lead', permissions: ['staff:read', 'staff:manage'] });
    expect(made.statusCode).toBe(201);
    const roleId = made.json().id;
    const given = await call('PATCH', `/v1/staff/${support.membershipId}`, adminMember.email, tenantId, { role: 'custom', customRoleId: roleId });
    expect(given.json()).toMatchObject({ role: 'custom', customRole: { id: roleId, name: 'Team lead' } });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(support.email)) });
    expect(me.json().memberships[0].permissions.sort()).toEqual(['staff:manage', 'staff:read']);
    const audit = await admin.query("select details from platform.audit_log where tenant_id = $1 and action = 'role.created'", [tenantId]);
    expect(audit.rows).toEqual([{ details: { basedOn: 'support', permissions: 'staff:manage,staff:read' } }]);
  });

  it("refuses a permission the editor doesn't hold, editing your own role, and deleting a role in use", async () => {
    const { tenantId, members } = await tenantWith('owner', 'admin');
    const adminMember = members[1]!;
    expect((await call('POST', '/v1/roles', adminMember.email, tenantId, { basedOn: 'support', name: 'Reviewer', permissions: ['break_glass:review'] })).json().error.code).toBe('cannot_grant');

    const roleId = await createCustomRole(tenantId, ['staff:read', 'staff:manage', 'roles:manage']);
    const holder = await createUser();
    await addMember(tenantId, holder.id, 'custom', 'active', roleId);
    expect((await call('PATCH', `/v1/roles/${roleId}`, holder.email, tenantId, { name: 'Mine now' })).json().error.code).toBe('own_role');
    expect((await call('DELETE', `/v1/roles/${roleId}`, adminMember.email, tenantId)).json().error.code).toBe('role_in_use');

    const unused = await createCustomRole(tenantId, ['staff:read']);
    expect((await call('DELETE', `/v1/roles/${unused}`, adminMember.email, tenantId)).statusCode).toBe(200);
  });

  it("can't see or change another tenant's role", async () => {
    const theirs = await tenantWith('owner');
    const roleId = await createCustomRole(theirs.tenantId, ['staff:read']);
    const { tenantId, members } = await tenantWith('owner');
    expect((await call('PATCH', `/v1/roles/${roleId}`, members[0]!.email, tenantId, { name: 'Taken' })).statusCode).toBe(404);
    const listed = await call('GET', '/v1/roles', members[0]!.email, tenantId);
    expect(listed.json().customRoles).toEqual([]);
    const seen = await withTenant({ tenantId, actor: { type: 'person', userId: members[0]!.id }, requestId: 'test' }, (tx) =>
      tx.db.select({ id: roles.id }).from(roles),
    );
    expect(seen).toEqual([]);
  });
});

describe('sign-in history (ADM6)', () => {
  it('keeps one row per session, for the person and their tenant to read, and no other tenant', async () => {
    const { tenantId, members } = await tenantWith('owner', 'support');
    const support = members[1]!;
    const sessionId = `sess_${crypto.randomUUID()}`;
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: 'GET', url: '/v1/me', headers: { ...headers(await signIn(support.email, undefined, { sessionId })), 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' } });
    }
    const own = await app.inject({ method: 'GET', url: '/v1/me/sign-ins', headers: headers(await signIn(support.email)) });
    expect(own.json().signIns).toMatchObject([{ device: 'Safari on macOS', secondFactor: true }]);
    const byOwner = await call('GET', `/v1/staff/${support.membershipId}/sign-ins`, members[0]!.email, tenantId);
    expect(byOwner.json().signIns).toHaveLength(1);

    const stranger = await tenantWith('owner');
    const seen = await withTenant({ tenantId: stranger.tenantId, actor: { type: 'person', userId: stranger.members[0]!.id }, requestId: 'test' }, (tx) =>
      tx.db.select({ id: signIns.id }).from(signIns).where(sql`${signIns.userId} = ${support.id}`),
    );
    expect(seen).toEqual([]);
  });
});

describe('break-glass (ADM3)', () => {
  it('is not needed by a role that holds no clinical permission', async () => {
    const { tenantId, members } = await tenantWith('support');
    const reply = await call('POST', '/v1/break-glass', members[0]!.email, tenantId, { reason: 'Checking a reported incident' });
    expect(reply.json().error.code).toBe('break_glass_not_needed');
  });

  it('is reviewed by the medical director, never by the person who opened it, and only in its tenant', async () => {
    const { tenantId, members } = await tenantWith('owner', 'medical_director');
    const [owner, director] = members as [(typeof members)[0], (typeof members)[0]];
    const { rows } = await admin.query<{ id: string }>(
      `insert into platform.break_glass (tenant_id, membership_id, user_id, reason, ends_at)
       values ($1, $2, $3, 'Checking a reported incident', now() + interval '1 hour') returning id`,
      [tenantId, owner.membershipId, owner.id],
    );
    const id = rows[0]!.id;
    const list = await call('GET', '/v1/break-glass', director.email, tenantId);
    expect(list.json().breakGlass).toMatchObject([{ breakGlassId: id, userId: owner.id }]);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: headers(await signIn(owner.email)) });
    expect(me.json().memberships[0].breakGlass.until).not.toBeNull();

    const reviewed = await call('POST', `/v1/break-glass/${id}/review`, director.email, tenantId, { note: 'Matches the incident' });
    expect(reviewed.json().reviewedAt).not.toBeNull();
    const own = await admin.query<{ id: string }>(
      `insert into platform.break_glass (tenant_id, membership_id, user_id, reason, ends_at)
       values ($1, $2, $3, 'Reviewing my own access', now() + interval '1 hour') returning id`,
      [tenantId, director.membershipId, director.id],
    );
    expect((await call('POST', `/v1/break-glass/${own.rows[0]!.id}/review`, director.email, tenantId, {})).json().error.code).toBe('own_break_glass');

    const closed = await call('POST', '/v1/break-glass/close', owner.email, tenantId);
    expect(closed.json().breakGlass).toMatchObject([{ breakGlassId: id }]);
    expect(new Date(closed.json().breakGlass[0].endsAt).getTime()).toBeLessThanOrEqual(Date.now());
    const again = await call('POST', '/v1/break-glass/close', owner.email, tenantId);
    expect(again.json().breakGlass).toEqual([]);

    const stranger = await tenantWith('owner');
    const seen = await withTenant({ tenantId: stranger.tenantId, actor: { type: 'person', userId: stranger.members[0]!.id }, requestId: 'test' }, (tx) =>
      tx.db.select({ id: breakGlass.id }).from(breakGlass),
    );
    expect(seen).toEqual([]);
  });
});
