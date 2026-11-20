/**
 * Allowed values, in one place (ADR 0028). The database holds the same lists
 * as CHECK constraints, built from these constants, and
 * test/integration/schema-rules.test.ts fails when the two differ. Adding a
 * value means changing the constant and adding a migration.
 */

/** A staff member's role in one tenant (docs/decisions/foundation.md FND3). */
export const ROLES = ['owner', 'clinician', 'support', 'finance'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** Who did something: a person, one of Medora's AI agents, or the system itself (ADR 0008). */
export const ACTOR_TYPES = ['person', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** The data zones (ADR 0007). */
export const DATA_ZONES = ['clinical', 'operational', 'marketing', 'platform'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/** How a scheduled job's last run ended (ADR 0029). */
export const JOB_OUTCOMES = ['succeeded', 'failed'] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];

/** Currencies money is held in (ADR 0016). Australia only for now; the column is there for NZ and the UK. */
export const CURRENCIES = ['AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** What a fee is for, on prices, invoice lines and ledger lines (docs/decisions/billing.md). */
export const FEE_KINDS = ['consult', 'program', 'medicine', 'shipping'] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

/**
 * The ledger's accounts (docs/decisions/billing.md BIL3). Patient accounts
 * belong to a patient, processor clearing to a payment account, pharmacy
 * payable to a partner pharmacy; the rest are one per tenant.
 */
export const LEDGER_ACCOUNT_KINDS = [
  'patient_receivable',
  'patient_credit',
  'processor_clearing',
  'pharmacy_payable',
  'revenue_consult',
  'revenue_program',
  'revenue_medicine',
  'revenue_shipping',
  'gst_collected',
] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

/** Why money moved (BIL4). A correction is always a `reversal` of the entry it corrects. */
export const LEDGER_ENTRY_KINDS = [
  'invoice_issued',
  'payment_received',
  'refund_paid',
  'credit_granted',
  'credit_applied',
  'chargeback',
  'reversal',
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** The companies that move card payments for Medora's tenants (ADR 0019). */
export const PROCESSORS = ['stripe', 'eway'] as const;
export type Processor = (typeof PROCESSORS)[number];

/**
 * A payment account's life (docs/decisions/billing.md BIL9): `setting_up`
 * until the processor first says it can take payments, then `active`.
 * `closed` takes no new subscriptions; the ones it already has carry on.
 */
export const PAYMENT_ACCOUNT_STATUSES = ['setting_up', 'active', 'closed'] as const;
export type PaymentAccountStatus = (typeof PAYMENT_ACCOUNT_STATUSES)[number];

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
  { table: 'platform.job_leases', column: 'last_outcome', values: JOB_OUTCOMES },
  { table: 'operational.ledger_accounts', column: 'kind', values: LEDGER_ACCOUNT_KINDS },
  { table: 'operational.ledger_accounts', column: 'currency', values: CURRENCIES },
  { table: 'operational.ledger_entries', column: 'kind', values: LEDGER_ENTRY_KINDS },
  { table: 'operational.ledger_lines', column: 'fee_kind', values: FEE_KINDS },
  { table: 'operational.payment_accounts', column: 'processor', values: PROCESSORS },
  { table: 'operational.payment_accounts', column: 'status', values: PAYMENT_ACCOUNT_STATUSES },
] as const;
