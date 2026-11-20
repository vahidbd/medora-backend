import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { paymentAccounts } from './payments.js';
import { tenants } from './platform.js';
import { BILLING_MODELS, FEE_KINDS, GST_TREATMENTS, INTERVAL_UNITS, PRICE_STATUSES } from './values.js';
import { operational } from './zones.js';

/**
 * Prices (docs/decisions/billing.md BIL13 to BIL17): what a program costs and
 * how often it is charged. A price is edited as a draft; once live it never
 * changes (the database refuses), and a change is a new version that
 * replaces it, so a subscription always knows exactly what it agreed to.
 */
export const prices = operational.table(
  'prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Foreign key owed until programs merge (BIL5). */
    programId: uuid('program_id').notNull(),
    /** What staff call it, e.g. "Monthly". */
    name: text('name').notNull(),
    billingModel: text('billing_model').notNull(),
    intervalUnit: text('interval_unit').notNull(),
    intervalCount: integer('interval_count').notNull(),
    /** Charges go here instead of the tenant's default payment account (BIL11). */
    paymentAccountId: uuid('payment_account_id'),
    status: text('status').notNull().default('draft'),
    version: integer('version').notNull().default(1),
    /** The live price this version replaces when it is published. */
    replacesPriceId: uuid('replaces_price_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('prices_tenant_id_key').on(table.tenantId, table.id),
    // Lets each fee carry its price's billing model, so the database can refuse a medicine fee on a pharmacy-billed price.
    unique('prices_billing_model_key').on(table.tenantId, table.id, table.billingModel),
    foreignKey({
      name: 'prices_payment_account_fk',
      columns: [table.tenantId, table.paymentAccountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
    }),
    foreignKey({ name: 'prices_replaces_fk', columns: [table.tenantId, table.replacesPriceId], foreignColumns: [table.tenantId, table.id] }),
    // A price is revised once; the revision is revised in its turn.
    uniqueIndex('prices_replaces_key').on(table.tenantId, table.replacesPriceId),
    index('prices_program_idx').on(table.tenantId, table.programId),
    index('prices_payment_account_idx').on(table.tenantId, table.paymentAccountId),
    check('prices_billing_model_check', oneOf(table.billingModel, BILLING_MODELS)),
    check('prices_status_check', oneOf(table.status, PRICE_STATUSES)),
    check('prices_interval_unit_check', oneOf(table.intervalUnit, INTERVAL_UNITS)),
    check(
      'prices_interval_check',
      sql`${table.intervalCount} between 1 and (case ${table.intervalUnit} when 'week' then 52 else 12 end)`,
    ),
    check('prices_name_check', sql`length(${table.name}) between 1 and 80`),
    check(
      'prices_lifecycle_check',
      sql`(${table.status} = 'draft') = (${table.publishedAt} is null)
        and (${table.status} = 'retired') = (${table.retiredAt} is not null)
        and (${table.replacesPriceId} is null) = (${table.version} = 1)`,
    ),
  ],
);

export const priceFees = operational.table(
  'price_fees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    priceId: uuid('price_id').notNull(),
    /** Its price's billing model, kept in step by the foreign key. */
    billingModel: text('billing_model').notNull(),
    feeKind: text('fee_kind').notNull(),
    /** Medicine fees only: the catalogue product it is for. Foreign key owed until the catalogue merges (BIL5). */
    productId: uuid('product_id'),
    /** GST-inclusive, as the patient sees it. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** Medicine fees only: the part that belongs to the partner pharmacy (BIL3). */
    pharmacyShareCents: bigint('pharmacy_share_cents', { mode: 'number' }),
    gstTreatment: text('gst_treatment').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'price_fees_price_fk',
      columns: [table.tenantId, table.priceId, table.billingModel],
      foreignColumns: [prices.tenantId, prices.id, prices.billingModel],
    }).onUpdate('cascade'),
    index('price_fees_price_idx').on(table.tenantId, table.priceId, table.billingModel),
    uniqueIndex('price_fees_kind_key').on(table.tenantId, table.priceId, table.feeKind).where(sql`${table.feeKind} <> 'medicine'`),
    uniqueIndex('price_fees_product_key').on(table.tenantId, table.priceId, table.productId).where(sql`${table.productId} is not null`),
    check('price_fees_billing_model_check', oneOf(table.billingModel, BILLING_MODELS)),
    check('price_fees_fee_kind_check', oneOf(table.feeKind, FEE_KINDS)),
    check('price_fees_gst_treatment_check', oneOf(table.gstTreatment, GST_TREATMENTS)),
    check('price_fees_amount_check', sql`${table.amountCents} > 0`),
    check(
      'price_fees_medicine_check',
      sql`(${table.feeKind} = 'medicine') = (${table.productId} is not null)
        and (${table.feeKind} = 'medicine') = (${table.pharmacyShareCents} is not null)
        and (${table.feeKind} <> 'medicine' or ${table.billingModel} = 'bundled')
        and (${table.pharmacyShareCents} is null or ${table.pharmacyShareCents} between 0 and ${table.amountCents})`,
    ),
  ],
);
