import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { paymentAccounts } from './payments.js';
import { tenants } from './platform.js';
import { CURRENCIES, FEE_KINDS, LEDGER_ACCOUNT_KINDS, LEDGER_ENTRY_KINDS } from './values.js';
import { operational } from './zones.js';

/**
 * The billing ledger (ADR 0016, docs/decisions/billing.md BIL1 to BIL5): one
 * double-entry ledger per tenant, in integer cents. Positive amounts are
 * debits, negative are credits, and each entry's lines sum to zero (checked
 * by the database when the transaction commits). Entries and lines are
 * append-only for every role; a mistake is corrected by a reversal.
 */

export const ledgerAccounts = operational.table(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    currency: text('currency').notNull().default('AUD'),
    /** Patient accounts only. Foreign key owed until patients merge (BIL5). */
    patientId: uuid('patient_id'),
    /** Processor clearing only. */
    paymentAccountId: uuid('payment_account_id'),
    /** Pharmacy payable only. Foreign key owed until partner pharmacies merge (BIL5). */
    partnerPharmacyId: uuid('partner_pharmacy_id'),
    /** A cache of the sum of this account's lines, kept under the posting's lock and checked nightly (BIL2). */
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ledger_accounts_tenant_id_key').on(table.tenantId, table.id),
    unique('ledger_accounts_owner_key')
      .on(table.tenantId, table.kind, table.currency, table.patientId, table.paymentAccountId, table.partnerPharmacyId)
      .nullsNotDistinct(),
    foreignKey({
      name: 'ledger_accounts_payment_account_fk',
      columns: [table.tenantId, table.paymentAccountId],
      foreignColumns: [paymentAccounts.tenantId, paymentAccounts.id],
    }),
    index('ledger_accounts_payment_account_idx').on(table.tenantId, table.paymentAccountId),
    check('ledger_accounts_kind_check', oneOf(table.kind, LEDGER_ACCOUNT_KINDS)),
    check('ledger_accounts_currency_check', oneOf(table.currency, CURRENCIES)),
    check(
      'ledger_accounts_owner_check',
      sql`(${table.kind} in ('patient_receivable', 'patient_credit')) = (${table.patientId} is not null)
        and (${table.kind} = 'processor_clearing') = (${table.paymentAccountId} is not null)
        and (${table.kind} = 'pharmacy_payable') = (${table.partnerPharmacyId} is not null)`,
    ),
  ],
);

export const ledgerEntries = operational.table(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    /** Posting the same key again returns this entry instead of posting twice (BIL1). */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The entry a reversal undoes. An entry is reversed at most once. */
    reversesEntryId: uuid('reverses_entry_id'),
    /** When the money moved in the world (a processor's time); postedAt is when it was written. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('ledger_entries_tenant_id_key').on(table.tenantId, table.id),
    unique('ledger_entries_idempotency_key').on(table.tenantId, table.idempotencyKey),
    foreignKey({ name: 'ledger_entries_reverses_fk', columns: [table.tenantId, table.reversesEntryId], foreignColumns: [table.tenantId, table.id] }),
    uniqueIndex('ledger_entries_reverses_key').on(table.tenantId, table.reversesEntryId),
    check('ledger_entries_kind_check', oneOf(table.kind, LEDGER_ENTRY_KINDS)),
    check('ledger_entries_reversal_check', sql`(${table.kind} = 'reversal') = (${table.reversesEntryId} is not null)`),
    check('ledger_entries_key_check', sql`length(${table.idempotencyKey}) between 1 and 200`),
  ],
);

export const ledgerLines = operational.table(
  'ledger_lines',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryId: uuid('entry_id').notNull(),
    accountId: uuid('account_id').notNull(),
    /** Debit positive, credit negative; never zero. */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** What the money was for, when it was for a fee (BIL3). */
    feeKind: text('fee_kind'),
  },
  (table) => [
    // Through the tenant as well as the id, so a line can never reach another tenant's entry or account.
    foreignKey({ name: 'ledger_lines_entry_fk', columns: [table.tenantId, table.entryId], foreignColumns: [ledgerEntries.tenantId, ledgerEntries.id] }),
    foreignKey({ name: 'ledger_lines_account_fk', columns: [table.tenantId, table.accountId], foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id] }),
    index('ledger_lines_entry_idx').on(table.tenantId, table.entryId),
    index('ledger_lines_account_idx').on(table.tenantId, table.accountId, table.id),
    check('ledger_lines_amount_check', sql`${table.amountCents} <> 0`),
    check('ledger_lines_fee_kind_check', sql`${table.feeKind} is null or ${oneOf(table.feeKind, FEE_KINDS)}`),
  ],
);
