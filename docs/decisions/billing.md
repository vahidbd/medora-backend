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

Decision: `patient_id`, `payment_account_id` and `partner_pharmacy_id` on ledger accounts are uuids without a foreign key until those tables merge (patients from intake, payment accounts from billing's next part, partner pharmacies from orders). `FOREIGN_KEYS_OWED` in `test/integration/schema-rules.test.ts` lists each with the table it will reference; the test fails as soon as that table exists, so the foreign key is added in the next migration and the column leaves the list.
Why: billing is built alongside those features; waiting for them would stall it, and a forgotten foreign key is exactly what ADR 0028 forbids. The tenant id's foreign key and row-level security are real from the start.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### BIL6. Finance reads the ledger; nobody writes it through a route

Decision: `GET /v1/ledger/accounts` and `GET /v1/ledger/accounts/:accountId/entries` need `ledger:read`, held by finance and the owner. No route posts or reverses: entries come only from the billing services that move money, inside their own transaction.
Why: the PRD gives finance the money; support works from invoices and payments, not the ledger. A posting route would be a way to move money with no invoice, payment or refund behind it.

### BIL7. GST is one eleventh of each GST-inclusive line

Decision: prices are stored GST-inclusive, as the patient sees them. The GST in a taxable line is one eleventh of it, rounded to the nearest cent (`gstIncluded` in `src/lib/money.ts`), worked out per line, so an invoice's GST is the sum of its lines'.
Why: Australian prices shown to consumers include GST; per-line rounding makes every line's figures add up on the tax invoice.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.
