import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { MembershipRole, MembershipStatus, Role } from '../../src/db/schema/values.js';

/**
 * Fixtures, written as the superuser so they can set up any tenant. Made-up
 * tenants and people only. The app under test still connects as medora_api.
 */
export const admin = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL, max: 4 });

export async function createTenant(name = `Test clinic ${randomUUID().slice(0, 8)}`): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('insert into platform.tenants (name) values ($1) returning id', [name]);
  return rows[0]!.id;
}

export interface TestUser {
  id: string;
  email: string;
}

/** An invited person: an account with an email, not yet linked to a sign-in. */
export async function createUser(email = `${randomUUID()}@example.test`): Promise<TestUser> {
  const { rows } = await admin.query<{ id: string }>('insert into platform.users (email) values ($1) returning id', [email]);
  return { id: rows[0]!.id, email };
}

export async function addMember(
  tenantId: string,
  userId: string,
  role: MembershipRole,
  status: MembershipStatus = 'active',
  customRoleId: string | null = null,
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into platform.memberships (tenant_id, user_id, role, status, custom_role_id, invited_at)
     values ($1, $2, $3, $4, $5, case when $4 = 'invited' then now() end) returning id`,
    [tenantId, userId, role, status, customRoleId],
  );
  return rows[0]!.id;
}

/** A custom role in a tenant (docs/decisions/admin.md ADM1). */
export async function createCustomRole(tenantId: string, permissions: string[], basedOn: Role = 'support', name = `Role ${randomUUID().slice(0, 8)}`): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into platform.roles (tenant_id, name, permissions, based_on, clinical)
     values ($1, $2, $3, $4, $4 in ('prescriber', 'clinician', 'medical_director')) returning id`,
    [tenantId, name, permissions, basedOn],
  );
  return rows[0]!.id;
}

/** A tenant with one member per role given, each an invited person. */
export async function tenantWith(...roles: Role[]): Promise<{ tenantId: string; members: (TestUser & { membershipId: string; role: Role })[] }> {
  const tenantId = await createTenant();
  const members = [];
  for (const role of roles) {
    const user = await createUser();
    members.push({ ...user, role, membershipId: await addMember(tenantId, user.id, role) });
  }
  return { tenantId, members };
}
