# Billing

Rulings for billing and payments: the ledger, payment accounts, processors, prices, subscriptions, invoices, payments, refunds and credits. ADRs 0016 (money), 0019 (Stripe and eWAY), 0021 (two billing models), 0029 (outside calls after commit) and 0009 (no medicine charged without a current script) set the rules; these record the choices made while building them. Rulings marked "Decided by: stand-in" were settled by the product owner's stand-in while the product owner was away, and are to be confirmed.

### BIL1. One double-entry ledger per tenant, in cents, written once

Decision: every money movement is a ledger entry (`operational.ledger_entries`) with two or more lines (`operational.ledger_lines`) in whole cents: positive is a debit, negative a credit, and an entry's lines sum to zero. The database checks the sum when the transaction commits, and refuses any change or delete of an entry or line for every role, the owner included. An entry carries an idempotency key that names the movement (`payment:<id>:received`); posting the same key again returns the first entry and writes nothing, and the same key with different lines is refused (`idempotency_conflict`). One ledger per tenant, not per company: each payment account names its company and each invoice its issuing company, which is enough for a chart of accounts per company later (FIN-01, TEN-08). Lines reach their entry and account through the tenant as well as the id, so a line can never point into another tenant.
Why: ADR 0016. The key makes a retried webhook, job or request harmless.
Decided by: stand-in (Fable 5.2), to confirm with Vahid (one ledger per tenant).

### BIL2. Balances are cached under the posting's lock and checked every night

Decision: each account keeps `balance_cents`, a cache of its lines' sum. A posting locks every account it touches (`FOR UPDATE`, lowest id first) before writing lines, then adds to each cache. The job `ledger-balance-check` compares every cache with its lines once a day, logs each difference as an error and fails; it never corrects. Comparing with Stripe's and eWAY's records joins it once payments land.
Why: ADR 0016. Locking in id order means two postings on the same accounts wait for each other instead of deadlocking or losing one.

### BIL3. A small fixed set of accounts, and every line says what it was for

Decision: patient receivable and patient credit (per patient), processor clearing (per payment account), pharmacy payable (per partner pharmacy), revenue per fee kind (consult, program, medicine, shipping) and GST collected (one each per tenant). An account is made the first time a posting needs it. There is no processor fees account yet: billing doesn't know a fee when it charges, and settlement reconciliation (FIN-03) adds it. For a bundled medicine line, the pharmacy's agreed share is credited to pharmacy payable and the rest to medicine revenue; there is no cost account. Every line may carry its fee kind, so finance can present gross or net.
Why: the smallest set that tells finance what each patient owes, what each pharmacy is owed and what was earned per fee kind. Whether a tenant sells medicine as principal or as the pharmacy's agent is for the tenant's accountant to confirm before the first patient.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL4. Entries say why money moved, and a correction is a reversal

Decision: an entry's kind is one of `invoice_issued`, `payment_received`, `refund_paid`, `credit_granted`, `credit_applied`, `chargeback` or `reversal`. A reversal negates every line of one entry, names it, and is the only way to undo it; an entry is reversed at most once, and a reversal is never reversed (post the movement again). Refunds and chargebacks move the same accounts back the other way; they add no account kinds.
Why: the ledger shows the mistake and its fix (ADR 0016). A partial refund is not a reversal of a whole entry, so it has its own kind.

### BIL5. Columns that will point at another feature's table wait for it, and a test says so

Decision: `patient_id` and `partner_pharmacy_id` on ledger accounts, `company_id` on payment accounts, `program_id` on prices, `product_id` on price fees and `patient_id` on subscriptions are uuids without a foreign key until those tables merge (patients and programs from intake, partner pharmacies from orders, companies and products from tenant settings and the catalogue). `payment_account_id` got its foreign key, through the tenant, when payment accounts arrived. `FOREIGN_KEYS_OWED` in `test/integration/schema-rules.test.ts` lists each with the table it will reference; the test fails as soon as that table exists, so the foreign key is added in the next migration and the column leaves the list.
Why: billing is built alongside those features; waiting for them would stall it, and a forgotten foreign key is exactly what ADR 0028 forbids. The tenant id's foreign key and row-level security are real from the start.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL6. Finance reads the ledger; nobody writes it through a route

Decision: `GET /v1/ledger/accounts` and `GET /v1/ledger/accounts/:accountId/entries` need `ledger:read`, held by finance and the owner. No route posts or reverses: entries come only from the billing services that move money, inside their own transaction.
Why: the PRD gives finance the money; support works from invoices and payments, not the ledger. A posting route would be a way to move money with no invoice, payment or refund behind it.

### BIL7. GST is one eleventh of each GST-inclusive line

Decision: prices are stored GST-inclusive, as the patient sees them. The GST in a taxable line is one eleventh of it, rounded to the nearest cent (`gstIncluded` in `src/lib/money.ts`), worked out per line, so an invoice's GST is the sum of its lines'.
Why: Australian prices shown to consumers include GST; per-line rounding makes every line's figures add up on the tax invoice.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL8. A tenant connects Stripe on Stripe's own pages, and is charged on its own account

Decision: Stripe through Connect with Standard accounts and direct charges (ADR 0160). Adding a Stripe payment account opens nothing; the first onboarding link opens the tenant's Stripe account (country AU, with Medora's tenant and payment account ids as metadata and nothing else) and sends staff to Stripe's onboarding pages. Coming back lands on `/settings/payment-accounts/<id>?onboarding=returned` in the console, or `?onboarding=expired` when the link ran out, and the console asks the API to refresh. Until Stripe's events are processed, the refresh route (`POST /v1/payment-accounts/:id/refresh`) is how the account's state is read.
Why: the tenant's business, bank and identity details stay with Stripe, Medora holds no tenant's keys, and patients' money never passes through Medora. Standard accounts give the tenant Stripe's full dashboard for disputes and payouts.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL9. A payment account is setting up, active or closed, and is never deleted

Decision: a new payment account is `setting_up`. It becomes `active` the first time the processor says it can take payments (`charges_enabled`), and stays active if the processor later stops them, with `chargesEnabled` showing the processor's latest word and an event saying it changed. Staff can close an account to new subscriptions (its subscriptions carry on) and reopen it, which returns it to active if it was ever active, or to setting up. There is no delete, for any role: invoices and the ledger point at payment accounts.
Why: closing instead of removing keeps every past invoice and ledger line pointing at a real account, and a processor pausing payments is an alert for staff, not a change of what the account is.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL10. A processor account is opened once, and a payment account keeps it

Decision: the processor account is opened after the commit that recorded who asked (`payment_account.onboarding_started`), with `payment-account-open:<payment account id>` as the idempotency key, so a second click or a retry gets the same account. Its id is then recorded; once set it never changes (a trigger refuses), and one processor account can belong to only one payment account in all of Medora.
Why: ADR 0029 (outside calls after commit, with a key). Pointing a payment account at another processor account would send its patients' money somewhere else without anyone choosing that. If the recording fails after Stripe opened the account and more than a day passes before a retry (Stripe keeps keys for 24 hours), a second Stripe account can be opened; the first is left unused with Medora's ids on it, for support to remove.

### BIL11. One default payment account per tenant, and always an active one

Decision: new subscriptions use the payment account their price names, or else the tenant's default (a brand's default can come later). The first payment account to become active is made the default when the tenant has none. Staff move the default by making another active account the default; the default can't be closed until another one is. The database allows one default per tenant and only an active one. Changes lock all the tenant's payment accounts in id order, so two staff choosing different defaults at once leave exactly one.
Why: a subscription must always resolve to an account that can take payments, and a tenant with one account shouldn't have to choose it twice.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL12. Finance and the owner manage payment accounts; no agent does

Decision: every payment account route needs `payment_accounts:manage`, held by finance and the owner. No agent tool adds, connects, closes or changes one. Each change writes an audit entry and an event (`payment_account.created`, `.connected`, `.processor_state_changed`, `.activated`, `.made_default`, `.renamed`, `.closed`, `.reopened`); asking for an onboarding link is audited too (`payment_account.onboarding_started`), because the link opens the tenant's bank details. Events carry ids and facts only.
Why: where a tenant's money goes is a person's decision (ADR 0012), and the PRD gives money to finance.

### BIL13. A price belongs to one program and lists its fees

Decision: a price names its program, its billing model (bundled or pharmacy-billed, ADR 0021), how often it charges, optionally a payment account (BIL11), and its fees: at most one each of consult, program and shipping, and, when bundled, one medicine fee per catalogue product with the pharmacy's share of it. A pharmacy-billed price has no medicine fees (the database refuses one). The medicine fee charged in a period is the one for the product on the patient's current script; when the script's product has no medicine fee on the price, no invoice is made and staff are told, and billing never falls back to another fee. A consult fee is charged once, as its own invoice at checkout, not every period.
Why: the smallest shape that covers both billing models, and a wrong medicine charge is worse than a late one.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL14. A live price never changes; a change is a new version

Decision: a price is a draft until published, and only a draft can be edited. Revising a live price makes a draft copy one version on (`replaces_price_id`); publishing it makes it live and retires the version it replaces, in one transaction. A price is revised at most once, so versions form a single line. The database refuses any change to a published price or its fees other than retiring it, and prices are never deleted. A subscription keeps the version it started on; moving existing subscribers to a new version will be an explicit staff action taking effect from the first billing period at least 30 days after a notice the system sent and recorded, and a decrease can apply from the next period.
Why: past invoices stay explainable, and consumer law notice of a price rise must be provable.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL15. A price charges every 1 to 52 weeks, or every 1 to 12 months

Decision: the interval is whole weeks (1 to 52) or whole months (1 to 12). Billing period dates are worked out in the patient's time zone (ADR 0017); a monthly subscription keeps its anchor day, so one started on the 31st renews on 28 February and then 31 March. Retiring a price stops new subscriptions on it; the ones it has carry on.
Why: patients get a predictable date that doesn't drift earlier month by month.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL16. Each fee has a GST treatment, defaulted and then confirmed

Decision: every fee is `taxable` or `gst_free`. Left out, consults and medicine default to GST-free, program fees to taxable, and shipping follows the medicine it carries (GST-free on a price with a medicine fee, taxable otherwise). Publishing needs `gstTreatmentsConfirmed: true`, the tenant's word that it checked each one. Invoice lines will copy the treatment and the GST, so a later change applies to new invoices only. The defaults are for the tenant's accountant to confirm before the first patient.
Why: GST depends on the tenant's services, so Medora suggests and the tenant decides; replies show the GST in each fee (`gstCents`, BIL7) so the decision is visible.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL17. Finance and the owner manage prices; no agent does

Decision: every price route needs `prices:manage`, held by finance and the owner. No agent tool creates, publishes or retires a price. Creating, publishing and retiring write an audit entry and an event (`price.created`, `price.published`, `price.retired`); editing a draft is audited but emits nothing, as nobody outside the staff editing it sees a draft.
Why: what patients are charged is a person's decision (ADR 0012), and the PRD gives money to finance.

### BIL18. One live subscription per patient per program, fixed at checkout

Decision: checkout starts a subscription on a live price for the patient. It keeps the price version (BIL14), the payment account (the price's, or else the tenant's default, which must be active, BIL11) and the patient's time zone at that moment, which sets every period date and the 10:00 renewal (ADR 0017). A patient has at most one subscription per program that hasn't ended; the database refuses a second, even from two checkouts at once, and the subscription's program is held to its price's by a foreign key. Once one ends, the patient can start another.
Why: two live subscriptions to one program would charge twice for the same care.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL19. Pending, active, paused, cancelled; the first period starts when it is released

Decision: a subscription waits as `pending` until its first billing period's invoice is released after the clinician accepts, and that day starts period 1 and sets the anchor day. A period that starts off its schedule (released late, overdue on resume, or on a pause's resume date) starts on its release date and sets a new anchor day from it, as there is no proration (P8b) and every period is a full one. An anchor on the 29th to 31st falls on a shorter month's last day without changing the anchor. Invoices, the renewal job and the re-anchoring arrive with invoices; this part holds the dates.
Why: the patient pays for care from the day it is approved, not from checkout.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL20. Pauses and skips put the next period off by three months at most

Decision: a pause names the date the next period starts: after today in the patient's time zone, no earlier than the current period's end, and at most three months after it. Resuming sets the next period back to the current period's end; if that has passed, the period is due now and goes through the same late release and clinical gate as any overdue renewal. A skip moves the next period one interval on along the anchor day, only before that period's invoice is released (enforced with invoices). A paused subscription changes its resume date instead of skipping. Pauses and skips share the same three months, which the database also checks. Pausing will void a held, unreleased invoice, and resuming makes a fresh one through the gate.
Why: a short break shouldn't need a cancel and a new checkout, and a longer one should; a single cap is easy to explain.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL21. Cancel at the period's end or now; reasons are codes; nothing is refunded by itself

Decision: cancelling at the period's end keeps the subscription running until the current period ends, with the reason kept beside it, and reinstating before then clears both. Cancelling now ends it today. With no paid days left (still pending, or the current period already over) a cancel at the period's end ends it today too, and will void any held invoice in the same transaction. A reason is a code: `patient_request`, `staff_decision` or `other` from staff, and `clinician_declined` only from the consult's outcome, which the staff route refuses. Cancelling never prorates or refunds; a refund is its own action. An ended subscription is never changed or deleted.
Why: codes keep patient details out of billing records (ADR 0008), and a refund is a money decision a person makes on purpose.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL22. Support, finance and the owner manage subscriptions; no agent does yet

Decision: `subscriptions:read` and `subscriptions:manage` are held by support, finance and the owner. Clinicians hold neither; a clinician declining cancels the subscription as part of the consult outcome, without a subscription permission. Every change writes an audit entry and an event (`subscription.started`, `activated`, `paused`, `resumed`, `skipped`, `cancellation_scheduled`, `reinstated`, `cancelled`) with the patient's and program's ids, never patient details, so orders can hold or cancel an order it placed when a subscription pauses or ends. No agent tool changes a subscription yet: the support agent's tools and their limits are decided when that agent is built (ADR 0012).
Why: support handles a patient's request to pause or stop, and finance answers for the money.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.
