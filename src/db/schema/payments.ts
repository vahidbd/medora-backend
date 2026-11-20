import { sql } from 'drizzle-orm';
import { boolean, check, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
