import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { brandDomains, brands, companies } from '../../db/schema/index.js';
import type { BrandStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { brokenConstraint } from '../../lib/database-errors.js';
import { BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { Brand, BrandChange, BrandDomain, BrandInput, PublicBrand } from './brands.schemas.js';
import { colourReadable, normaliseHost } from './checks.js';
import { getSettings, onboarding } from './tenant.service.js';

/**
 * Brands and the hosts they answer on (docs/decisions/admin.md ADM15 to
 * ADM17). A brand starts as a draft; it goes live once it has a support
 * email and a host platform staff have verified; paused stops new patients
 * only, and resuming is going live again. It never goes back to draft.
 */

type BrandRow = typeof brands.$inferSelect;
type DomainRow = typeof brandDomains.$inferSelect;

const toDomain = (row: DomainRow): BrandDomain => ({ domainId: row.id, host: row.host, verifiedAt: row.verifiedAt?.toISOString() ?? null });

const toBrand = (row: BrandRow, domains: DomainRow[]): Brand => ({
  brandId: row.id,
  companyId: row.companyId,
  name: row.name,
  slug: row.slug,
  status: row.status as BrandStatus,
  supportEmail: row.supportEmail,
  supportPhone: row.supportPhone,
  primaryColour: row.primaryColour,
  logoUrl: row.logoUrl,
  domains: domains.filter((domain) => domain.brandId === row.id).map(toDomain),
  updatedAt: row.updatedAt.toISOString(),
});

async function domainsOf(tx: TenantTx, brandIds: string[]): Promise<DomainRow[]> {
  if (brandIds.length === 0) return [];
  return tx.db
    .select()
    .from(brandDomains)
    .where(and(eq(brandDomains.tenantId, tx.context.tenantId), inArray(brandDomains.brandId, brandIds)))
    .orderBy(asc(brandDomains.host));
}

/** Every brand in the tenant, with its hosts. */
export async function listBrands(tx: TenantTx): Promise<Brand[]> {
  const rows = await tx.db.select().from(brands).where(eq(brands.tenantId, tx.context.tenantId)).orderBy(asc(brands.name));
  const domains = await domainsOf(tx, rows.map((row) => row.id));
  return rows.map((row) => toBrand(row, domains));
}

async function findBrand(tx: TenantTx, brandId: string, lock = false): Promise<BrandRow> {
  const query = tx.db.select().from(brands).where(and(eq(brands.tenantId, tx.context.tenantId), eq(brands.id, brandId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Brand');
  return row;
}

/** One brand in the tenant, with its hosts. NotFoundError when it isn't this tenant's. */
export async function getBrand(tx: TenantTx, brandId: string): Promise<Brand> {
  const row = await findBrand(tx, brandId);
  return toBrand(row, await domainsOf(tx, [row.id]));
}

async function assertCompany(tx: TenantTx, companyId: string): Promise<void> {
  const [found] = await tx.db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.tenantId, tx.context.tenantId), eq(companies.id, companyId)));
  if (!found) throw new BadRequestError('Choose one of your companies', 'company_not_found');
}

function assertColour(colour: string | null | undefined): void {
  if (colour && !colourReadable(colour)) {
    throw new BadRequestError("Text can't be read on that colour. Choose a darker or lighter one.", 'colour_unreadable');
  }
}

function brandRefusal(error: unknown): never {
  const constraint = brokenConstraint(error);
  if (constraint === 'brands_slug_key') throw new BusinessRuleError('Another brand already uses that address name', 'slug_taken');
  if (constraint === 'brands_tenant_name_key') throw new BusinessRuleError('Another brand here already has that name', 'brand_name_taken');
  throw error;
}

export async function createBrand(tx: TenantTx, input: BrandInput): Promise<Brand> {
  await assertCompany(tx, input.companyId);
  assertColour(input.primaryColour);
  const values = {
    tenantId: tx.context.tenantId,
    companyId: input.companyId,
    name: input.name,
    slug: input.slug,
    supportEmail: input.supportEmail ?? null,
    supportPhone: input.supportPhone ?? null,
    primaryColour: input.primaryColour ?? null,
    logoUrl: input.logoUrl ?? null,
  };
  const row = await tx.db.insert(brands).values(values).returning().then(([inserted]) => inserted!, brandRefusal);
  const record = { recordTable: 'platform.brands', recordId: row.id } as const;
  const facts = { companyId: input.companyId, slug: input.slug };
  await audit(tx, { action: 'brand.created', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'brand.created', ...record, payload: facts });
  return toBrand(row, []);
}

export async function changeBrand(tx: TenantTx, brandId: string, change: BrandChange): Promise<Brand> {
  const before = await findBrand(tx, brandId, true);
  const companyId = change.companyId ?? before.companyId;
  if (companyId !== before.companyId) {
    // Patients and their invoices know a live brand by its company (ADM19).
    if (before.status !== 'draft') throw new BusinessRuleError("A live or paused brand stays with its company", 'company_fixed');
    await assertCompany(tx, companyId);
  }
  assertColour(change.primaryColour);
  const supportEmail = change.supportEmail === undefined ? before.supportEmail : change.supportEmail;
  if (before.status !== 'draft' && !supportEmail) {
    throw new BusinessRuleError('A live or paused brand needs a support email', 'support_email_required');
  }
  const after = {
    companyId,
    name: change.name ?? before.name,
    supportEmail,
    supportPhone: change.supportPhone === undefined ? before.supportPhone : change.supportPhone,
    primaryColour: change.primaryColour === undefined ? before.primaryColour : change.primaryColour,
    logoUrl: change.logoUrl === undefined ? before.logoUrl : change.logoUrl,
    updatedAt: new Date(),
  };
  const [row] = await tx.db
    .update(brands)
    .set(after)
    .where(and(eq(brands.tenantId, tx.context.tenantId), eq(brands.id, brandId)))
    .returning()
    .catch(brandRefusal);
  const record = { recordTable: 'platform.brands', recordId: brandId } as const;
  const changed = (Object.keys(change) as (keyof BrandChange)[]).sort().join(',');
  await audit(tx, { action: 'brand.changed', zone: 'platform', ...record, details: { changed, companyId } });
  await emitEvent(tx, { type: 'brand.changed', ...record, payload: { changed, companyId } });
  return toBrand(row!, await domainsOf(tx, [brandId]));
}

/** Go live, pause, or resume (ADM16). Going live and resuming need a support email and a verified host. */
export async function setBrandStatus(tx: TenantTx, brandId: string, status: 'live' | 'paused'): Promise<Brand> {
  const before = await findBrand(tx, brandId, true);
  if (before.status === status) return getBrand(tx, brandId);
  if (status === 'paused' && before.status !== 'live') throw new BusinessRuleError('Only a live brand can be paused', 'not_live');
  if (status === 'live') {
    if (!before.supportEmail) throw new BusinessRuleError('Add a support email before going live', 'support_email_required');
    const [verified] = await tx.db
      .select({ id: brandDomains.id })
      .from(brandDomains)
      .where(and(eq(brandDomains.tenantId, tx.context.tenantId), eq(brandDomains.brandId, brandId), isNotNull(brandDomains.verifiedAt)))
      .limit(1);
    if (!verified) throw new BusinessRuleError('A brand goes live once Medora has verified one of its domains', 'domain_unverified');
  }
  await tx.db
    .update(brands)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(brands.tenantId, tx.context.tenantId), eq(brands.id, brandId)));
  const record = { recordTable: 'platform.brands', recordId: brandId } as const;
  const facts = { from: before.status, to: status };
  await audit(tx, { action: 'brand.status_changed', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'brand.status_changed', ...record, payload: facts });
  return getBrand(tx, brandId);
}

/** A host for the brand, unverified until platform staff check it (ADM15). */
export async function addDomain(tx: TenantTx, brandId: string, typed: string): Promise<Brand> {
  await findBrand(tx, brandId, true);
  const host = normaliseHost(typed);
  if (!host) throw new BadRequestError('Enter a domain like app.example.com.au', 'host_invalid');
  const row = await tx.db
    .insert(brandDomains)
    .values({ tenantId: tx.context.tenantId, brandId, host })
    .returning()
    .then(
      ([inserted]) => inserted!,
      (error: unknown) => {
        if (brokenConstraint(error) === 'brand_domains_host_key') throw new BusinessRuleError('That domain is already in use', 'host_taken');
        throw error;
      },
    );
  const record = { recordTable: 'platform.brand_domains', recordId: row.id } as const;
  await audit(tx, { action: 'brand_domain.added', zone: 'platform', ...record, details: { brandId, host } });
  await emitEvent(tx, { type: 'brand_domain.added', ...record, payload: { brandId, host } });
  return getBrand(tx, brandId);
}

/** Take a host away. A live brand keeps at least one verified host, or patients couldn't reach it. */
export async function removeDomain(tx: TenantTx, brandId: string, domainId: string): Promise<void> {
  const brand = await findBrand(tx, brandId, true);
  const domains = await domainsOf(tx, [brandId]);
  const domain = domains.find((row) => row.id === domainId);
  if (!domain) throw new NotFoundError('Domain');
  const verifiedLeft = domains.filter((row) => row.id !== domainId && row.verifiedAt !== null).length;
  if (brand.status !== 'draft' && domain.verifiedAt !== null && verifiedLeft === 0) {
    throw new BusinessRuleError("This is the brand's only verified domain. Add another and have it verified first.", 'last_verified_domain');
  }
  await tx.db.delete(brandDomains).where(and(eq(brandDomains.tenantId, tx.context.tenantId), eq(brandDomains.id, domainId)));
  const record = { recordTable: 'platform.brand_domains', recordId: domainId } as const;
  await audit(tx, { action: 'brand_domain.removed', zone: 'platform', ...record, details: { brandId, host: domain.host } });
  await emitEvent(tx, { type: 'brand_domain.removed', ...record, payload: { brandId, host: domain.host } });
}

/**
 * Whether the brand may take a new patient (ADM16, ADM18): it is live (not
 * a draft, not paused) and its tenant's onboarding checklist is complete.
 * Patient sign-up calls this before it creates anyone.
 */
export async function assertAcceptingPatients(tx: TenantTx, brandId: string): Promise<void> {
  const brand = await findBrand(tx, brandId);
  if (brand.status !== 'live') throw new BusinessRuleError("This service isn't taking new patients right now", 'brand_not_accepting');
  const checklist = await onboarding(tx);
  if (!checklist.ready) throw new BusinessRuleError("This service isn't taking new patients yet", 'tenant_not_ready');
}

/** What a public page shows about its brand (ADM16): nothing a patient or staff member typed. */
export async function publicBrand(tx: TenantTx, brandId: string): Promise<PublicBrand | null> {
  const [row] = await tx.db.select().from(brands).where(and(eq(brands.tenantId, tx.context.tenantId), eq(brands.id, brandId)));
  if (!row || row.status === 'draft') return null;
  const settings = await getSettings(tx);
  return {
    brandId: row.id,
    tenantId: row.tenantId,
    name: row.name,
    status: row.status as 'live' | 'paused',
    logoUrl: row.logoUrl,
    primaryColour: row.primaryColour,
    supportEmail: row.supportEmail,
    supportPhone: row.supportPhone,
    timeZone: settings.timeZone,
  };
}
