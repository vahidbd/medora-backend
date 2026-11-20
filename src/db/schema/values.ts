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

/** Who charges the patient for the medicine (ADR 0021). Pharmacy-billed prices have no medicine fees. */
export const BILLING_MODELS = ['bundled', 'pharmacy_billed'] as const;
export type BillingModel = (typeof BILLING_MODELS)[number];

/** A price is edited as a draft, then live until it is retired; a live price never changes (BIL14). */
export const PRICE_STATUSES = ['draft', 'live', 'retired'] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

/** How often a price charges: every 1 to 52 weeks, or every 1 to 12 months (BIL15). */
export const INTERVAL_UNITS = ['week', 'month'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

/** GST on a fee (ruling BIL7): prices include it, and a GST-free fee has none. */
export const GST_TREATMENTS = ['taxable', 'gst_free'] as const;
export type GstTreatment = (typeof GST_TREATMENTS)[number];

/**
 * A subscription's life (docs/decisions/billing.md BIL19): `pending` from
 * checkout until its first billing period is released, then `active`,
 * `paused` between periods, and `cancelled` once it has ended.
 */
export const SUBSCRIPTION_STATUSES = ['pending', 'active', 'paused', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Why a subscription ended (BIL21). Codes only: a note could carry patient details. */
export const CANCEL_REASONS = ['patient_request', 'clinician_declined', 'staff_decision', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Why a due billing period has no invoice yet (BIL24): the last answer the
 * renewal job got. Codes only, nothing clinical beyond them.
 */
export const HELD_REASONS = [
  'awaiting_clinician',
  'no_order',
  'no_current_script',
  'awaiting_pharmacist',
  'cannot_dispense',
  'no_medicine_fee',
  'other',
] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

/** An invoice for the consult at checkout, or for a billing period (BIL23). */
export const INVOICE_KINDS = ['consult', 'period'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/**
 * An issued invoice is `open` until it is paid; `past_due` once a charge for
 * it has failed or there was no card to charge; `void` when it no longer
 * stands, keeping its number (BIL29).
 */
export const INVOICE_STATUSES = ['open', 'paid', 'past_due', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * A payment's life (BIL28): `pending` from before the processor is asked
 * until it answers, then `succeeded` or `failed`. A succeeded payment whose
 * invoice can't stand is `refunding`, then `refunded` once the processor
 * accepts the refund.
 */
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunding', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

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
  { table: 'operational.prices', column: 'billing_model', values: BILLING_MODELS },
  { table: 'operational.prices', column: 'status', values: PRICE_STATUSES },
  { table: 'operational.prices', column: 'interval_unit', values: INTERVAL_UNITS },
  { table: 'operational.price_fees', column: 'billing_model', values: BILLING_MODELS },
  { table: 'operational.price_fees', column: 'fee_kind', values: FEE_KINDS },
  { table: 'operational.price_fees', column: 'gst_treatment', values: GST_TREATMENTS },
  { table: 'operational.subscriptions', column: 'status', values: SUBSCRIPTION_STATUSES },
  { table: 'operational.subscriptions', column: 'cancel_reason', values: CANCEL_REASONS },
  { table: 'operational.subscriptions', column: 'renewal_held_reason', values: HELD_REASONS },
  { table: 'operational.invoices', column: 'kind', values: INVOICE_KINDS },
  { table: 'operational.invoices', column: 'status', values: INVOICE_STATUSES },
  { table: 'operational.invoice_lines', column: 'fee_kind', values: FEE_KINDS },
  { table: 'operational.invoice_lines', column: 'gst_treatment', values: GST_TREATMENTS },
  { table: 'operational.payments', column: 'status', values: PAYMENT_STATUSES },
] as const;
