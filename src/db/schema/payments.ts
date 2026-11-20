import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants } from './platform.js';
import { PAYMENT_ACCOUNT_STATUSES, PROCESSORS } from './values.js';
import { operational } from './zones.js';

/**
 * Payment accounts (ADR 0160, docs/decisions/billing.md BIL8 to BIL12): each
 * one is a tenant's own account at a processor, so patients' money is paid
 * into the tenant's account and never passes through Medora's.
 */
export const paymentAccounts = operational.table(
  'payment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    processor: text('processor').notNull(),
    /** The company (legal entity) paid into this account. Foreign key owed until companies merge (BIL5). */
    companyId: uuid('company_id').notNull(),
    /** What staff call it, e.g. "Main card account". */
    name: text('name').notNull(),
    status: text('status').notNull().default('setting_up'),
    /** The processor's id for the tenant's account (Stripe's `acct_…`). Set once, never changed (BIL10). */
    processorAccountId: text('processor_account_id'),
    /** The processor's latest word on whether the account can take payments. */
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    /** New subscriptions use the tenant's default payment account unless their price names another (BIL11). */
    isDefault: boolean('is_default').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('payment_accounts_tenant_id_key').on(table.tenantId, table.id),
    // One processor account belongs to one payment account in all of Medora, so a processor's event finds its tenant.
    uniqueIndex('payment_accounts_processor_account_key').on(table.processor, table.processorAccountId),
    uniqueIndex('payment_accounts_default_key').on(table.tenantId).where(sql`${table.isDefault}`),
    check('payment_accounts_processor_check', oneOf(table.processor, PROCESSORS)),
    check('payment_accounts_status_check', oneOf(table.status, PAYMENT_ACCOUNT_STATUSES)),
    check('payment_accounts_name_check', sql`length(${table.name}) between 1 and 80`),
    check(
      'payment_accounts_lifecycle_check',
      sql`(${table.status} = 'closed') = (${table.closedAt} is not null)
        and (${table.status} <> 'active' or ${table.activatedAt} is not null)
        and (not ${table.isDefault} or ${table.status} = 'active')`,
    ),
  ],
);

/**
 * A patient's saved card or wallet at one payment account (BIL28). The
 * processor holds the card; Medora keeps its tokens and what a patient needs
 * to recognise it, never the card number. Saved only with the patient's
 * agreement to later charges made without them present.
 */
export const paymentMethods = operational.table(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Foreign key owed until patients merge (BIL5). */
    patientId: uuid('patient_id').notNull(),
    /** Cards are saved on the tenant's own account at the processor, so each belongs to one payment account (ADR 0160). */
    paymentAccountId: uuid('payment_account_id').notNull(),
    /** The processor's ids for the patient and the card (Stripe's `cus_…` and `pm_…`). */
    processorCustomerId: text('processor_customer_id').notNull(),
    processorMethodId: text('processor_method_id').notNull(),
    brand: text('brand').notNull(),
    last4: text('last4').notNull(),
    expMonth: integer('exp_month').notNull(),
    expYear: integer('exp_year').notNull(),
    /** The card period invoices are charged to. One per patient per payment account. */
    isDefault: boolean('is_default').notNull().default(false),
    /** When the patient agreed to later charges without them present. */
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('payment_methods_tenant_id_key').on(table.tenantId, table.id),
    // Lets a payment name its method's payment account, so the two can't differ.
    unique('payment_methods_account_key').on(table.tenantId, table.id, table.paymentAccountId),
    unique('payment_methods_processor_key').on(table.tenantId, table.paymentAccountId, table.processorMethodId),
    foreignKey({
      name: 'payment_methods_payment_account_fk',
      columns: [table.tenantId, table.paymentAccountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
    }),
    uniqueIndex('payment_methods_default_key').on(table.tenantId, table.patientId, table.paymentAccountId).where(sql`${table.isDefault}`),
    check(
      'payment_methods_card_check',
      sql`${table.last4} ~ '^[0-9]{4}$' and length(${table.brand}) between 1 and 20
        and ${table.expMonth} between 1 and 12 and ${table.expYear} between 2000 and 2100
        and length(${table.processorCustomerId}) between 1 and 255 and length(${table.processorMethodId}) between 1 and 255`,
    ),
  ],
);
