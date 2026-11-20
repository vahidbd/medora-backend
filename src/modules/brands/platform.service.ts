import { sql } from 'drizzle-orm';
import type { TimeZone } from '../../db/schema/values.js';
import type { PersonTx, PublicTx } from '../../db/tenant.js';
import { NotFoundError } from '../../lib/errors.js';
import type { PlatformDomain, PlatformTenant, TenantInput } from './brands.schemas.js';

/**
 * Platform staff's work across tenants (docs/decisions/admin.md ADM14,
 * ADM15), and finding a public page's brand (ADM16). Each goes through a
 * reviewed function in the tenant onboarding migration, which checks the
 * person is platform staff again and writes the audit entries and events in
 * the tenant concerned.
 */

type TenantRow = {
  tenant_id: string;
  tenant_name: string;
  time_zone: TimeZone;
  created_at: Date | string;
  owner_joined: boolean;
  brands: number;
  live_brands: number;
};

const toTenant = (row: TenantRow): PlatformTenant => ({
  tenantId: row.tenant_id,
  name: row.tenant_name,
  timeZone: row.time_zone,
  createdAt: new Date(row.created_at).toISOString(),
  ownerJoined: row.owner_joined,
  brands: row.brands,
  liveBrands: row.live_brands,
});

export async function platformTenants(tx: PersonTx): Promise<PlatformTenant[]> {
  const result = await tx.db.execute<TenantRow>(sql`select * from platform.platform_tenants()`);
  return result.rows.map(toTenant);
}

/** A new tenant, and its first owner's invitation. Answers the tenant and the email to send the invitation to. */
export async function createTenant(tx: PersonTx, input: TenantInput, requestId: string): Promise<{ tenant: PlatformTenant; ownerEmail: string }> {
  const created = await tx.db.execute<{ new_tenant_id: string }>(
    sql`select new_tenant_id from platform.create_tenant(${input.name}, ${input.timeZone}, ${input.ownerEmail}, ${input.ownerName ?? null}, ${requestId})`,
  );
  const tenantId = created.rows[0]?.new_tenant_id;
  const tenant = (await platformTenants(tx)).find((row) => row.tenantId === tenantId);
  if (!tenant) throw new Error('create_tenant answered no tenant');
  return { tenant, ownerEmail: input.ownerEmail.trim().toLowerCase() };
}

/** The first owner's invitation again (ADM14). Answers the email to send it to. */
export async function renewOwnerInvitation(tx: PersonTx, tenantId: string, requestId: string): Promise<string> {
  const renewed = await tx.db.execute<{ email: string | null }>(sql`select platform.renew_owner_invitation(${tenantId}, ${requestId}) as email`);
  const email = renewed.rows[0]?.email;
  if (!email) throw new NotFoundError('Owner invitation');
  return email;
}

type DomainRow = {
  domain_id: string;
  tenant_id: string;
  tenant_name: string;
  brand_id: string;
  brand_name: string;
  host: string;
  created_at: Date | string;
  verified_at: Date | string | null;
};

export async function platformDomains(tx: PersonTx, waiting: boolean): Promise<PlatformDomain[]> {
  const result = await tx.db.execute<DomainRow>(sql`select * from platform.platform_domains(${waiting})`);
  return result.rows.map((row) => ({
    domainId: row.domain_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    brandId: row.brand_id,
    brandName: row.brand_name,
    host: row.host,
    createdAt: new Date(row.created_at).toISOString(),
    verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString(),
  }));
}

/** Platform staff checked the host's DNS points at Medora (ADM15). */
export async function verifyDomain(tx: PersonTx, domainId: string, requestId: string): Promise<{ domainId: string; host: string }> {
  const verified = await tx.db.execute<{ host: string | null }>(sql`select platform.verify_domain(${domainId}, ${requestId}) as host`);
  const host = verified.rows[0]?.host;
  if (!host) throw new NotFoundError('Domain');
  return { domainId, host };
}

export interface ResolvedBrand {
  tenantId: string;
  brandId: string;
  status: 'live' | 'paused';
}

/**
 * The brand a public page belongs to, by a host platform staff verified or
 * by its slug (ADM16). Null for a draft brand, an unverified host or no
 * brand at all. A paused brand resolves: it keeps serving its patients and
 * takes no new ones, so check `status` (or assertAcceptingPatients) first.
 */
export async function resolvePublicBrand(tx: PublicTx, by: { host: string } | { slug: string }): Promise<ResolvedBrand | null> {
  const host = 'host' in by ? by.host.trim().toLowerCase() : null;
  const slug = 'slug' in by ? by.slug.trim().toLowerCase() : null;
  const result = await tx.db.execute<{ tenant_id: string; brand_id: string; status: 'live' | 'paused' }>(
    sql`select * from platform.resolve_brand(${host}, ${slug})`,
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, brandId: row.brand_id, status: row.status } : null;
}
