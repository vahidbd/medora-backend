import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { prices, subscriptions } from './billing.js';
import { oneOf } from './checks.js';
import { paymentAccounts } from './payments.js';
import { tenants } from './platform.js';
import { FEE_KINDS, GST_TREATMENTS, INVOICE_KINDS, INVOICE_STATUSES } from './values.js';
import { operational } from './zones.js';

/**
 * Invoices (docs/decisions/billing.md BIL23 to BIL27). An invoice exists only
 * once it is issued: numbered, priced from the subscription's price, and
 * posted to the ledger in the same transaction. A billing period's invoice is
 * issued only after orders clears the period; one with medicine names the
 * order behind it, and an order backs one invoice at most.
 */
export const invoices = operational.table(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The issuing company: its payment account's. Foreign key owed until companies merge (BIL5). */
    companyId: uuid('company_id').notNull(),
    /** `<prefix>-<number>`, gapless per company, given when issued (BIL25). */
    number: text('number').notNull(),
    /** Foreign key owed until patients merge (BIL5). */
    patientId: uuid('patient_id').notNull(),
    subscriptionId: uuid('subscription_id').notNull(),
    priceId: uuid('price_id').notNull(),
    paymentAccountId: uuid('payment_account_id').notNull(),
    kind: text('kind').notNull(),
    periodStartsOn: date('period_starts_on'),
    periodEndsOn: date('period_ends_on'),
    /** The order that cleared a period with medicine (BIL24). Foreign key owed until orders merge (BIL5). */
    orderId: uuid('order_id'),
    /** The pharmacy dispensing that order, owed its share. Foreign key owed until orders merge (BIL5). */
    partnerPharmacyId: uuid('partner_pharmacy_id'),
    status: text('status').notNull().default('open'),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    gstCents: bigint('gst_cents', { mode: 'number' }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('invoices_tenant_id_key').on(table.tenantId, table.id),
    // Lets a medicine line name its invoice's order, so the database refuses medicine without one.
    unique('invoices_order_key').on(table.tenantId, table.id, table.orderId),
    unique('invoices_number_key').on(table.tenantId, table.companyId, table.number),
    foreignKey({ name: 'invoices_subscription_fk', columns: [table.tenantId, table.subscriptionId], foreignColumns: [subscriptions.tenantId, subscriptions.id] }),
    foreignKey({ name: 'invoices_price_fk', columns: [table.tenantId, table.priceId], foreignColumns: [prices.tenantId, prices.id] }),
    foreignKey({
      name: 'invoices_payment_account_fk',
      columns: [table.tenantId, table.paymentAccountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
    }),
    index('invoices_subscription_idx').on(table.tenantId, table.subscriptionId),
    index('invoices_price_idx').on(table.tenantId, table.priceId),
    index('invoices_payment_account_idx').on(table.tenantId, table.paymentAccountId),
    index('invoices_patient_idx').on(table.tenantId, table.patientId, table.issuedAt),
    uniqueIndex('invoices_period_key').on(table.tenantId, table.subscriptionId, table.periodStartsOn).where(sql`${table.kind} = 'period'`),
    uniqueIndex('invoices_consult_key').on(table.tenantId, table.subscriptionId).where(sql`${table.kind} = 'consult'`),
    uniqueIndex('invoices_one_per_order_key').on(table.tenantId, table.orderId).where(sql`${table.orderId} is not null`),
    check('invoices_kind_check', oneOf(table.kind, INVOICE_KINDS)),
    check('invoices_status_check', oneOf(table.status, INVOICE_STATUSES)),
    check('invoices_number_check', sql`${table.number} ~ '^[A-Z0-9]{1,10}-[0-9]{6,}$'`),
    check(
      'invoices_shape_check',
      sql`(${table.kind} = 'period') = (${table.periodStartsOn} is not null and ${table.periodEndsOn} is not null)
        and (${table.periodEndsOn} > ${table.periodStartsOn}) is not false
        and (${table.orderId} is null) = (${table.partnerPharmacyId} is null)
        and (${table.kind} = 'period' or ${table.orderId} is null)
        and ${table.totalCents} > 0 and ${table.gstCents} between 0 and ${table.totalCents}`,
    ),
  ],
);

export const invoiceLines = operational.table(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid('invoice_id').notNull(),
    /** Medicine lines only: their invoice's order, held to it by the foreign key (BIL24). */
    orderId: uuid('order_id'),
    feeKind: text('fee_kind').notNull(),
    /** Medicine lines only. Foreign key owed until the catalogue merges (BIL5). */
    productId: uuid('product_id'),
    /** Copied from the price's fee, GST-inclusive (BIL16). */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    pharmacyShareCents: bigint('pharmacy_share_cents', { mode: 'number' }),
    gstTreatment: text('gst_treatment').notNull(),
    gstCents: bigint('gst_cents', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({ name: 'invoice_lines_invoice_fk', columns: [table.tenantId, table.invoiceId], foreignColumns: [invoices.tenantId, invoices.id] }),
    foreignKey({
      name: 'invoice_lines_order_fk',
      columns: [table.tenantId, table.invoiceId, table.orderId],
      foreignColumns: [invoices.tenantId, invoices.id, invoices.orderId],
    }),
    index('invoice_lines_invoice_idx').on(table.tenantId, table.invoiceId, table.orderId),
    check('invoice_lines_fee_kind_check', oneOf(table.feeKind, FEE_KINDS)),
    check('invoice_lines_gst_treatment_check', oneOf(table.gstTreatment, GST_TREATMENTS)),
    check(
      'invoice_lines_shape_check',
      sql`(${table.feeKind} = 'medicine') = (${table.orderId} is not null)
        and (${table.feeKind} = 'medicine') = (${table.productId} is not null)
        and (${table.feeKind} = 'medicine') = (${table.pharmacyShareCents} is not null)
        and ${table.amountCents} > 0
        and (${table.pharmacyShareCents} is null or ${table.pharmacyShareCents} between 0 and ${table.amountCents})
        and ${table.gstCents} between 0 and ${table.amountCents}
        and (${table.gstTreatment} = 'taxable' or ${table.gstCents} = 0)`,
    ),
  ],
);

/** Each issuing company's next invoice number (BIL25). Taken under the row's lock, in the issuing transaction, so numbers have no gaps. */
export const invoiceNumbers = operational.table(
  'invoice_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Foreign key owed until companies merge (BIL5). */
    companyId: uuid('company_id').notNull(),
    prefix: text('prefix').notNull().default('INV'),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (table) => [
    unique('invoice_numbers_company_key').on(table.tenantId, table.companyId),
    check('invoice_numbers_prefix_check', sql`${table.prefix} ~ '^[A-Z0-9]{1,10}$'`),
    check('invoice_numbers_last_number_check', sql`${table.lastNumber} >= 0`),
  ],
);
