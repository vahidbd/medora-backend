import { and, eq, sql } from 'drizzle-orm';
import { brandDomains, brands, companies, memberships, roles, tenants } from '../../db/schema/index.js';
import type { AuState, TimeZone } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { brokenConstraint } from '../../lib/database-errors.js';
import { BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { Company, CompanyChange, CompanyInput, Onboarding, TenantSettings, TenantSettingsChange } from './brands.schemas.js';
import { abnValid, normaliseAbn } from './checks.js';

/**
 * A tenant's own settings, its companies and its onboarding checklist
 * (docs/decisions/admin.md ADM18 to ADM20).
 */

export async function getSettings(tx: TenantTx): Promise<TenantSettings> {
  const [row] = await tx.db.select().from(tenants).where(eq(tenants.id, tx.context.tenantId));
  if (!row) throw new NotFoundError('Tenant');
  return { tenantId: row.id, name: row.name, timeZone: row.timeZone as TimeZone };
}

export async function changeSettings(tx: TenantTx, change: TenantSettingsChange): Promise<TenantSettings> {
  const before = await getSettings(tx);
  const after = { name: change.name ?? before.name, timeZone: change.timeZone ?? before.timeZone };
  await tx.db.update(tenants).set(after).where(eq(tenants.id, tx.context.tenantId));
  const record = { recordTable: 'platform.tenants', recordId: tx.context.tenantId } as const;
  // The name is the business's, not a person's, so it may go in the details.
  const facts = { nameChanged: after.name !== before.name, timeZone: after.timeZone, timeZoneBefore: before.timeZone };
  await audit(tx, { action: 'tenant.changed', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'tenant.changed', ...record, payload: facts });
  return { ...before, ...after };
}

// Companies (ADM19).

type CompanyRow = typeof companies.$inferSelect;

const toCompany = (row: CompanyRow, brandCount: number): Company => ({
  companyId: row.id,
  legalName: row.legalName,
  tradingName: row.tradingName,
  abn: row.abn,
  state: row.state as AuState,
  brandCount,
  updatedAt: row.updatedAt.toISOString(),
});

async function brandCounts(tx: TenantTx): Promise<Map<string, number>> {
  const rows = await tx.db
    .select({ companyId: brands.companyId, count: sql<number>`count(*)::int` })
    .from(brands)
    .where(eq(brands.tenantId, tx.context.tenantId))
    .groupBy(brands.companyId);
  return new Map(rows.map((row) => [row.companyId, row.count]));
}

export async function listCompanies(tx: TenantTx): Promise<Company[]> {
  const counts = await brandCounts(tx);
  const rows = await tx.db.select().from(companies).where(eq(companies.tenantId, tx.context.tenantId)).orderBy(companies.legalName);
  return rows.map((row) => toCompany(row, counts.get(row.id) ?? 0));
}

async function findCompany(tx: TenantTx, id: string): Promise<CompanyRow> {
  const [row] = await tx.db
    .select()
    .from(companies)
    .where(and(eq(companies.tenantId, tx.context.tenantId), eq(companies.id, id)))
    .for('update');
  if (!row) throw new NotFoundError('Company');
  return row;
}

function checkedAbn(typed: string): string {
  const abn = normaliseAbn(typed);
  if (!abnValid(abn)) throw new BadRequestError("That ABN isn't valid. Check the 11 digits.", 'abn_invalid');
  return abn;
}

function companyRefusal(error: unknown): never {
  if (brokenConstraint(error) === 'companies_tenant_abn_key') {
    throw new BusinessRuleError('Another company here already has that ABN', 'abn_taken');
  }
  throw error;
}

export async function createCompany(tx: TenantTx, input: CompanyInput): Promise<Company> {
  const abn = checkedAbn(input.abn);
  const values = {
    tenantId: tx.context.tenantId,
    legalName: input.legalName,
    tradingName: input.tradingName || null,
    abn,
    state: input.state,
  };
  const row = await tx.db.insert(companies).values(values).returning().then(([inserted]) => inserted!, companyRefusal);
  const record = { recordTable: 'platform.companies', recordId: row.id } as const;
  await audit(tx, { action: 'company.created', zone: 'platform', ...record, details: { abn, state: input.state } });
  await emitEvent(tx, { type: 'company.created', ...record, payload: { abn, state: input.state } });
  return toCompany(row, 0);
}

export async function changeCompany(tx: TenantTx, id: string, change: CompanyChange): Promise<Company> {
  const before = await findCompany(tx, id);
  const abn = change.abn === undefined ? before.abn : checkedAbn(change.abn);
  if (abn !== before.abn) {
    // A live brand's company is the business patients are dealing with; its ABN is fixed while it trades (ADM19).
    const [live] = await tx.db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.tenantId, tx.context.tenantId), eq(brands.companyId, id), sql`${brands.status} <> 'draft'`))
      .limit(1);
    if (live) throw new BusinessRuleError("A company with a live or paused brand keeps its ABN. Add a new company instead.", 'abn_fixed');
  }
  const after = {
    legalName: change.legalName ?? before.legalName,
    tradingName: change.tradingName === undefined ? before.tradingName : change.tradingName || null,
    abn,
    state: change.state ?? before.state,
    updatedAt: new Date(),
  };
  const [row] = await tx.db
    .update(companies)
    .set(after)
    .where(and(eq(companies.tenantId, tx.context.tenantId), eq(companies.id, id)))
    .returning()
    .catch(companyRefusal);
  const record = { recordTable: 'platform.companies', recordId: id } as const;
  const facts = { abn, abnChanged: abn !== before.abn, state: after.state };
  await audit(tx, { action: 'company.changed', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'company.changed', ...record, payload: facts });
  return toCompany(row!, (await brandCounts(tx)).get(id) ?? 0);
}

export async function deleteCompany(tx: TenantTx, id: string): Promise<void> {
  await findCompany(tx, id);
  if (((await brandCounts(tx)).get(id) ?? 0) > 0) {
    throw new BusinessRuleError('This company still has brands. Move them to another company first.', 'company_has_brands');
  }
  await tx.db.delete(companies).where(and(eq(companies.tenantId, tx.context.tenantId), eq(companies.id, id)));
  const record = { recordTable: 'platform.companies', recordId: id } as const;
  await audit(tx, { action: 'company.deleted', zone: 'platform', ...record });
  await emitEvent(tx, { type: 'company.deleted', ...record });
}

// The onboarding checklist (ADM18): worked out from the tenant's data, never ticked by hand.

/** Active, not past its end date, in this starting role or a custom role copied from it. */
const holdsRole = (role: 'medical_director' | 'prescriber') => sql`exists (
  select 1 from ${memberships} m
    left join ${roles} r on r.tenant_id = m.tenant_id and r.id = m.custom_role_id
   where m.tenant_id = ${sql.raw('t.id')} and m.status = 'active' and (m.expires_at is null or m.expires_at > now())
     and (m.role = ${role} or (m.role = 'custom' and r.based_on = ${role})))`;

export async function onboarding(tx: TenantTx): Promise<Onboarding> {
  const result = await tx.db.execute<{ company: boolean; live_brand: boolean; medical_director: boolean; prescriber: boolean }>(sql`
    select exists (select 1 from ${companies} c where c.tenant_id = t.id) as company,
           exists (select 1 from ${brands} b
                    where b.tenant_id = t.id and b.status = 'live'
                      and exists (select 1 from ${brandDomains} d
                                   where d.tenant_id = b.tenant_id and d.brand_id = b.id and d.verified_at is not null)) as live_brand,
           ${holdsRole('medical_director')} as medical_director,
           ${holdsRole('prescriber')} as prescriber
      from ${tenants} t where t.id = ${tx.context.tenantId}`);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Tenant');
  const items = (['company', 'live_brand', 'medical_director', 'prescriber'] as const).map((key) => ({ key, done: row[key] === true }));
  return { ready: items.every((item) => item.done), items };
}
