import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, foreignKey, index, integer, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { paymentAccounts } from './payments.js';
import { tenants } from './platform.js';
import { BILLING_MODELS, CANCEL_REASONS, FEE_KINDS, GST_TREATMENTS, INTERVAL_UNITS, PRICE_STATUSES, SUBSCRIPTION_STATUSES } from './values.js';
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
    // Lets each subscription carry its price's program, for one live subscription per program (BIL18).
    unique('prices_program_key').on(table.tenantId, table.id, table.programId),
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

/**
 * Subscriptions (docs/decisions/billing.md BIL18 to BIL22): a patient's
 * recurring billing for one program, on one price version. Dates are
 * calendar dates in the subscription's time zone (ADR 0017); a billing
 * period runs from its start date up to, not including, its end date.
 */
export const subscriptions = operational.table(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Foreign key owed until patients merge (BIL5). */
    patientId: uuid('patient_id').notNull(),
    /** The price's program (the foreign key holds them together), so the database allows one live subscription per program (BIL18). */
    programId: uuid('program_id').notNull(),
    priceId: uuid('price_id').notNull(),
    /** Resolved at checkout from the price or the tenant's default, and kept (BIL11). */
    paymentAccountId: uuid('payment_account_id').notNull(),
    /** The patient's zone at checkout, for period dates and the 10:00 renewal (BIL18). */
    timeZone: text('time_zone').notNull(),
    status: text('status').notNull().default('pending'),
    /** Monthly prices: the day of the month periods start on, clamped in shorter months (BIL15). */
    anchorDay: smallint('anchor_day'),
    currentPeriodStartsOn: date('current_period_starts_on'),
    currentPeriodEndsOn: date('current_period_ends_on'),
    /** When the next billing period starts: the current period's end, or later after a pause or skip (BIL20). */
    nextPeriodStartsOn: date('next_period_starts_on'),
    cancelsAtPeriodEnd: boolean('cancels_at_period_end').notNull().default(false),
    /** Set when it ends, or when it is due to end at the period's end (BIL21). */
    cancelReason: text('cancel_reason'),
    endedOn: date('ended_on'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('subscriptions_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      name: 'subscriptions_price_fk',
      columns: [table.tenantId, table.priceId, table.programId],
      foreignColumns: [prices.tenantId, prices.id, prices.programId],
    }),
    foreignKey({
      name: 'subscriptions_payment_account_fk',
      columns: [table.tenantId, table.paymentAccountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
    }),
    uniqueIndex('subscriptions_live_key').on(table.tenantId, table.patientId, table.programId).where(sql`${table.status} <> 'cancelled'`),
    index('subscriptions_patient_idx').on(table.tenantId, table.patientId),
    index('subscriptions_price_idx').on(table.tenantId, table.priceId, table.programId),
    index('subscriptions_payment_account_idx').on(table.tenantId, table.paymentAccountId),
    check('subscriptions_status_check', oneOf(table.status, SUBSCRIPTION_STATUSES)),
    check('subscriptions_cancel_reason_check', sql`${table.cancelReason} is null or ${oneOf(table.cancelReason, CANCEL_REASONS)}`),
    check('subscriptions_anchor_day_check', sql`${table.anchorDay} between 1 and 31`),
    check(
      'subscriptions_lifecycle_check',
      sql`(${table.status} = 'pending') = (${table.activatedAt} is null and ${table.status} <> 'cancelled')
        and (${table.status} not in ('active', 'paused')
          or (${table.currentPeriodStartsOn} is not null and ${table.currentPeriodEndsOn} is not null and ${table.nextPeriodStartsOn} is not null))
        and (${table.status} = 'cancelled') = (${table.cancelledAt} is not null)
        and (${table.status} = 'cancelled' or ${table.cancelsAtPeriodEnd}) = (${table.cancelReason} is not null)
        and (not ${table.cancelsAtPeriodEnd} or ${table.status} in ('active', 'paused'))
        and (${table.status} = 'cancelled') = (${table.endedOn} is not null)
        and (${table.currentPeriodEndsOn} > ${table.currentPeriodStartsOn}) is not false
        and (${table.nextPeriodStartsOn} >= ${table.currentPeriodEndsOn}) is not false
        and (${table.nextPeriodStartsOn} <= ${table.currentPeriodEndsOn} + interval '3 months') is not false`,
    ),
  ],
);
