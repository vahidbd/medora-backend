import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { prices, subscriptions } from './billing.js';
import { oneOf } from './checks.js';
import { paymentAccounts, paymentMethods } from './payments.js';
import { tenants } from './platform.js';
import { FEE_KINDS, GST_TREATMENTS, INVOICE_KINDS, INVOICE_STATUSES, PAYMENT_STATUSES } from './values.js';
import { operational } from './zones.js';

/**
 * Invoices (docs/decisions/billing.md BIL23 to BIL27). An invoice exists only
 * once it is issued: numbered, priced from the subscription's price, and
 * posted to the ledger in the same transaction. A billing period's invoice is
 * issued only after orders clears the period; one with medicine names the
 * order behind it, and an order backs one invoice at most. Afterwards only its
 * status moves: paid, past due, or void (BIL29).
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
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** A void invoice keeps its number; its ledger entry is reversed (BIL29). */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    /** The patient's date it went past due, kept once it is paid or void (BIL31). */
    pastDueOn: date('past_due_on'),
    /** The patient's date of the next retry; null once the last has started, or when not past due (BIL31). */
    retryDueOn: date('retry_due_on'),
  },
  (table) => [
    unique('invoices_tenant_id_key').on(table.tenantId, table.id),
    // Lets a medicine line name its invoice's order, so the database refuses medicine without one.
    unique('invoices_order_key').on(table.tenantId, table.id, table.orderId),
    unique('invoices_number_key').on(table.tenantId, table.companyId, table.number),
    // Lets a payment name its invoice's payment account and total, so it can't take another amount (BIL28).
    unique('invoices_payment_key').on(table.tenantId, table.id, table.paymentAccountId, table.totalCents),
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
    // A void invoice gives up its period and its order, so they can be issued again once cleared (BIL29).
    uniqueIndex('invoices_period_key')
      .on(table.tenantId, table.subscriptionId, table.periodStartsOn)
      .where(sql`${table.kind} = 'period' and ${table.status} <> 'void'`),
    uniqueIndex('invoices_consult_key').on(table.tenantId, table.subscriptionId).where(sql`${table.kind} = 'consult'`),
    uniqueIndex('invoices_one_per_order_key').on(table.tenantId, table.orderId).where(sql`${table.orderId} is not null and ${table.status} <> 'void'`),
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
    check('invoices_settled_check', sql`(${table.status} = 'paid') = (${table.paidAt} is not null) and (${table.status} = 'void') = (${table.voidedAt} is not null)`),
    check(
      'invoices_retry_check',
      sql`(${table.status} <> 'past_due' or ${table.pastDueOn} is not null)
        and (${table.retryDueOn} is null or (${table.status} = 'past_due' and ${table.retryDueOn} > ${table.pastDueOn}))`,
    ),
    // The retries job's question every 15 minutes: which past-due invoices are due again (BIL31).
    index('invoices_retry_due_idx').on(table.tenantId, table.retryDueOn).where(sql`${table.retryDueOn} is not null`),
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

/**
 * One attempt to take an invoice's total from a saved payment method
 * (BIL28). The row is written before the processor is called, so a retry
 * reuses its idempotency key; the database lets an invoice have one attempt
 * in flight and take its money once, and holds every attempt to the
 * invoice's total and payment account.
 */
export const payments = operational.table(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid('invoice_id').notNull(),
    paymentAccountId: uuid('payment_account_id').notNull(),
    paymentMethodId: uuid('payment_method_id').notNull(),
    /** 1 for the first try, then one more for each later try. */
    attempt: integer('attempt').notNull(),
    /** Which scheduled retry this was (1 to 4); null for the first try and a new card's (BIL31). */
    retry: integer('retry'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('pending'),
    /** The processor's id for the charge (Stripe's `pi_…`), once it has one. */
    processorPaymentId: text('processor_payment_id'),
    /** The processor's reason for a failure, for support; never shown to the patient as is. */
    failureCode: text('failure_code'),
    processorRefundId: text('processor_refund_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the processor said yes or no. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
  },
  (table) => [
    unique('payments_tenant_id_key').on(table.tenantId, table.id),
    unique('payments_attempt_key').on(table.tenantId, table.invoiceId, table.attempt),
    foreignKey({
      name: 'payments_invoice_fk',
      columns: [table.tenantId, table.invoiceId, table.paymentAccountId, table.amountCents],
      foreignColumns: [invoices.tenantId, invoices.id, invoices.paymentAccountId, invoices.totalCents],
    }),
    foreignKey({
      name: 'payments_payment_method_fk',
      columns: [table.tenantId, table.paymentMethodId, table.paymentAccountId],
      foreignColumns: [paymentMethods.tenantId, paymentMethods.id, paymentMethods.paymentAccountId],
    }),
    index('payments_invoice_idx').on(table.tenantId, table.invoiceId, table.paymentAccountId, table.amountCents),
    index('payments_payment_method_idx').on(table.tenantId, table.paymentMethodId, table.paymentAccountId),
    uniqueIndex('payments_in_flight_key').on(table.tenantId, table.invoiceId).where(sql`${table.status} = 'pending'`),
    uniqueIndex('payments_taken_key').on(table.tenantId, table.invoiceId).where(sql`${table.status} in ('succeeded', 'refunding', 'refunded')`),
    check('payments_status_check', oneOf(table.status, PAYMENT_STATUSES)),
    check(
      'payments_shape_check',
      sql`${table.attempt} >= 1 and ${table.amountCents} > 0 and ${table.retry} between 1 and 4 is not false
        and (${table.status} = 'pending') = (${table.settledAt} is null)
        and (${table.status} = 'failed') = (${table.failureCode} is not null)
        and (${table.status} not in ('succeeded', 'refunding', 'refunded') or ${table.processorPaymentId} is not null)
        and (${table.status} = 'refunded') = (${table.refundedAt} is not null)
        and (${table.status} = 'refunded') = (${table.processorRefundId} is not null)`,
    ),
  ],
);
