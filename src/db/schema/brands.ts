import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants, users } from './platform.js';
import { AU_STATES, BRAND_STATUSES } from './values.js';
import { platform } from './zones.js';

/**
 * A legal entity under a tenant (PRD TEN-08; docs/decisions/admin.md
 * ADM14), with its own ABN. Brands belong to one, and billing books and
 * payouts attach to it.
 */
export const companies = platform.table(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    legalName: text('legal_name').notNull(),
    tradingName: text('trading_name'),
    /** Eleven digits, no spaces, with a valid checksum (platform.abn_valid). */
    abn: text('abn').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('companies_tenant_id_key').on(table.tenantId, table.id),
    unique('companies_tenant_abn_key').on(table.tenantId, table.abn),
    check('companies_abn_check', sql`platform.abn_valid(${table.abn})`),
    check('companies_state_check', oneOf(table.state, AU_STATES)),
    check('companies_legal_name_check', sql`length(btrim(${table.legalName})) between 1 and 200`),
  ],
);

/**
 * A name and look a tenant sells under (ADR 0023: brand copy is data). The
 * slug is unique across Medora, because public pages can find a brand by it.
 */
export const brands = platform.table(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('draft'),
    supportEmail: text('support_email'),
    supportPhone: text('support_phone'),
    /** #rrggbb that white or near-black text reaches 4.5:1 on (ADM17); checked by the API, its shape by the database. */
    primaryColour: text('primary_colour'),
    logoUrl: text('logo_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('brands_tenant_id_key').on(table.tenantId, table.id),
    unique('brands_slug_key').on(table.slug),
    uniqueIndex('brands_tenant_name_key').on(table.tenantId, sql`lower(${table.name})`),
    index('brands_company_idx').on(table.tenantId, table.companyId),
    foreignKey({ name: 'brands_company_fk', columns: [table.tenantId, table.companyId], foreignColumns: [companies.tenantId, companies.id] }),
    check('brands_status_check', oneOf(table.status, BRAND_STATUSES)),
    check('brands_slug_check', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${table.slug}) between 2 and 40`),
    check('brands_name_check', sql`length(btrim(${table.name})) between 1 and 80`),
    check('brands_colour_check', sql`${table.primaryColour} ~ '^#[0-9a-f]{6}$'`),
    check('brands_logo_check', sql`${table.logoUrl} ~ '^https://'`),
    // A live brand can be reached by patients, so it says how to get help (ADM16).
    check('brands_live_check', sql`${table.status} = 'draft' or ${table.supportEmail} is not null`),
  ],
);

/**
 * A host a brand's public pages answer on (app.brand.com.au). It does
 * nothing until platform staff have verified it (ADM15), and a host belongs
 * to one brand across Medora.
 */
export const brandDomains = platform.table(
  'brand_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    brandId: uuid('brand_id').notNull(),
    host: text('host').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('brand_domains_tenant_id_key').on(table.tenantId, table.id),
    unique('brand_domains_host_key').on(table.host),
    index('brand_domains_brand_idx').on(table.tenantId, table.brandId),
    index('brand_domains_verified_by_idx').on(table.verifiedBy),
    foreignKey({ name: 'brand_domains_brand_fk', columns: [table.tenantId, table.brandId], foreignColumns: [brands.tenantId, brands.id] }),
    check(
      'brand_domains_host_check',
      sql`${table.host} ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$' and length(${table.host}) <= 253`,
    ),
    check('brand_domains_verified_check', sql`(${table.verifiedAt} is null) = (${table.verifiedBy} is null)`),
  ],
);
