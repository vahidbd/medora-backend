import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants, users } from './platform.js';
import { BLOCK_RULE_MATCHES, PRODUCT_KINDS, PRODUCT_STATUSES, SCHEDULES, STORAGE } from './values.js';
import { operational, platform } from './zones.js';

/**
 * Something a tenant sells: a medicine, a device or a service, with one
 * price (docs/decisions/catalogue.md CAT1). A medicine carries an ARTG
 * number or the compounded mark, so a block on either can't be dodged by
 * leaving it blank. Products are archived, never deleted.
 */
export const products = operational.table(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    /** S2, S3, S4 or S8 for a scheduled medicine; null when unscheduled, and always for a device or service. */
    schedule: text('schedule'),
    artgNumber: text('artg_number'),
    compounded: boolean('compounded').notNull().default(false),
    strength: text('strength'),
    form: text('form'),
    packSize: text('pack_size'),
    storage: text('storage').notNull().default('room'),
    priceCents: integer('price_cents').notNull(),
    gstFree: boolean('gst_free').notNull(),
    status: text('status').notNull().default('active'),
    /** The tenant's own block (CAT4), which it can lift. Medora's block rules are checked separately, when the product is used. */
    blockedReason: text('blocked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('products_tenant_id_key').on(table.tenantId, table.id),
    index('products_tenant_name_idx').on(table.tenantId, table.name),
    check('products_kind_check', oneOf(table.kind, PRODUCT_KINDS)),
    check('products_schedule_check', oneOf(table.schedule, SCHEDULES)),
    check('products_storage_check', oneOf(table.storage, STORAGE)),
    check('products_status_check', oneOf(table.status, PRODUCT_STATUSES)),
    check('products_name_check', sql`length(btrim(${table.name})) between 1 and 120`),
    check('products_artg_check', sql`${table.artgNumber} ~ '^[0-9]{3,8}$'`),
    check('products_price_check', sql`${table.priceCents} between 0 and 10000000`),
    check('products_blocked_reason_check', sql`length(btrim(${table.blockedReason})) between 3 and 300`),
    // CAT1: only a medicine has a schedule or the compounded mark, and a medicine says what it is.
    check('products_medicine_check', sql`${table.kind} = 'medicine' or (${table.schedule} is null and not ${table.compounded})`),
    check('products_identity_check', sql`${table.kind} <> 'medicine' or ${table.artgNumber} is not null or ${table.compounded}`),
  ],
);

/**
 * Medora's platform-wide rules for what no tenant may sell (ADR 0009;
 * docs/decisions/catalogue.md CAT2). Data, never code: platform staff add
 * them through platform.add_block_rule, and retiring one takes a reviewed
 * operator script. The same rules apply to every tenant.
 */
export const blockRules = platform.table(
  'block_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the rule matches on a product: its schedule, its ARTG number, or the compounded mark. */
    match: text('match').notNull(),
    /** The schedule or ARTG number matched; null for `compounded`. */
    value: text('value'),
    reason: text('reason').notNull(),
    sourceUrl: text('source_url'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    index('block_rules_added_by_idx').on(table.addedBy),
    uniqueIndex('block_rules_current_key')
      .on(table.match, sql`coalesce(${table.value}, '')`)
      .where(sql`${table.retiredAt} is null`),
    check('block_rules_match_check', oneOf(table.match, BLOCK_RULE_MATCHES)),
    check(
      'block_rules_value_check',
      sql`case ${table.match}
        when 'compounded' then ${table.value} is null
        when 'schedule' then ${table.value} ~ '^S[2348]$'
        when 'artg_number' then ${table.value} ~ '^[0-9]{3,8}$'
        else false end`,
    ),
    check('block_rules_reason_check', sql`length(btrim(${table.reason})) between 10 and 500`),
    check('block_rules_source_check', sql`${table.sourceUrl} ~ '^https://'`),
  ],
);
