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

/** A made-up ABN that passes the checksum: random digits until one does (about 1 in 89). */
export function makeAbn(): string {
  for (;;) {
    const abn = String(10 + Math.floor(Math.random() * 90)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    const sum = weights.reduce((total, weight, i) => total + (Number(abn[i]) - (i === 0 ? 1 : 0)) * weight, 0);
    if (sum % 89 === 0) return abn;
  }
}

/** Medora's own team member (docs/decisions/admin.md ADM15), with no membership anywhere. */
export async function createPlatformStaff(): Promise<TestUser> {
  const user = await createUser();
  await admin.query('update platform.users set platform_staff = true where id = $1', [user.id]);
  return user;
}

/** A company and a brand in a tenant, with a host, verified or not (ADM15 to ADM19). */
export async function createBrand(
  tenantId: string,
  options: { status?: 'draft' | 'live' | 'paused'; host?: string; verifiedBy?: string } = {},
): Promise<{ companyId: string; brandId: string; slug: string; domainId: string | null; host: string | null }> {
  const company = await admin.query<{ id: string }>(
    `insert into platform.companies (tenant_id, legal_name, abn, state) values ($1, 'Test Pty Ltd', $2, 'NSW') returning id`,
    [tenantId, makeAbn()],
  );
  const companyId = company.rows[0]!.id;
  const slug = `brand-${randomUUID().slice(0, 8)}`;
  const brand = await admin.query<{ id: string }>(
    `insert into platform.brands (tenant_id, company_id, name, slug, status, support_email)
     values ($1, $2, $3, $3, $4, 'help@example.test') returning id`,
    [tenantId, companyId, slug, options.status ?? 'draft'],
  );
  const brandId = brand.rows[0]!.id;
  if (!options.host) return { companyId, brandId, slug, domainId: null, host: null };
  const domain = await admin.query<{ id: string }>(
    `insert into platform.brand_domains (tenant_id, brand_id, host, verified_at, verified_by)
     values ($1, $2, $3, case when $4::uuid is null then null else now() end, $4::uuid) returning id`,
    [tenantId, brandId, options.host, options.verifiedBy ?? null],
  );
  return { companyId, brandId, slug, domainId: domain.rows[0]!.id, host: options.host };
}

const accepting = new Map<string, Promise<string>>();

/**
 * A brand through which the tenant takes new patients, made once per tenant:
 * a live brand on a verified domain, a medical director and a prescriber
 * (the onboarding checklist, ADM18). Patient sign-ups name it (IDN20).
 */
export function acceptingBrand(tenantId: string): Promise<string> {
  let brand = accepting.get(tenantId);
  if (!brand) {
    brand = (async () => {
      for (const role of ['medical_director', 'prescriber'] as const) await addMember(tenantId, (await createUser()).id, role);
      const verifiedBy = (await createPlatformStaff()).id;
      return (await createBrand(tenantId, { status: 'live', host: `${randomUUID().slice(0, 8)}.example.test`, verifiedBy })).brandId;
    })();
    accepting.set(tenantId, brand);
  }
  return brand;
}
