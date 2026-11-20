# Prescribing

Rulings for opening Parchment after a consult (ADRs 0009, 0013). `src/modules/prescribing/`.

Rulings marked "to confirm with Vahid" were made by a stand-in reviewer so the work could go ahead, and hold until the product owner confirms or replaces them.

### RX1. Parchment opens only after a recorded consult, and fails closed

Decision: a prescriber opens Parchment for a patient with `POST /v1/prescribing-sessions`. Only a person holding `prescribing:open` may, and no agent tool exists. In one transaction the service checks that the person may prescribe now (a current registration and indemnity, from credentials), that the consults module finds a qualifying consult between this prescriber and this patient, and that the patient's record has what Parchment needs (RX2). After that commits it calls Parchment: it finds the prescriber's account the first time (RX3), then creates or updates the patient. A second transaction checks the consult again and records the prescribing session, which scripts written in Parchment will link to. The reply is Parchment's page for the patient, which the web app opens in a new tab. If Parchment doesn't answer there is no session and no page. Until the patients, consults and credentials modules are connected, every open is refused (503 `prescribing_not_connected`).
Why: no script without a recorded real-time consult (ADR 0009). The Parchment calls are outside the transactions because a slow outside call must not hold database locks, and the gate is checked again after them because the consult or the prescriber's standing could change in between.

### RX2. Parchment gets identity and contact details only

Decision: Parchment receives the patient's names, date of birth, sex, email, mobile, home address and Medicare details, keyed by our patient id, and never intake answers, notes or anything else. Names, date of birth, an Australian mobile and a home address are required; the prescriber is told in plain words what's missing before anything is sent. Each patient is created in Parchment once and updated on each later open. If two first opens race and both create a patient in Parchment, the first link stored stands and is the one every later open and webhook uses.
Why: Parchment needs these to write a legal script and to send the token; nothing else it holds is needed (ADR 0005, `docs/providers.md`).
Decided by: stand-in reviewer, to confirm with Vahid.

### RX3. A prescriber's Parchment account is found by their email

Decision: the first time a prescriber opens Parchment, Medora lists the tenant's Parchment users and takes the one whose email is the prescriber's Medora sign-in email. Exactly one must match, or the prescriber is asked to have an owner add them to the clinic's Parchment under that email. The match is stored and used from then on.
Why: the email is already verified by sign-in, and an owner adds prescribers in Parchment by email. Asking prescribers to type a Parchment id would let them claim someone else's.

### RX4. Parchment credentials are deploy secrets, one organisation per tenant

Decision: Medora is one Parchment partner per environment (`PARCHMENT_PARTNER_ID`, `PARCHMENT_PARTNER_SECRET`). Each tenant that prescribes is one Parchment organisation, listed in the JSON secret `PARCHMENT_ORGANIZATIONS` with its organisation secret, its integration user and its webhook secret. The app checks the list when it starts, and its refusals never repeat a secret. A tenant with no entry has prescribing switched off and is told so. `PARCHMENT_MODE=fake` keeps everything in memory for development and tests; production refuses it, and refuses Parchment's sandbox addresses. A webhook signed with a tenant's secret but naming another organisation fails and waits in the inbox for a person. Credentials move to encrypted tenant settings before a second tenant goes live.
Why: one tenant at launch doesn't need a settings screen for secrets, and a secret in the deploy environment is never in the database, the repo or a log.
Decided by: stand-in reviewer, to confirm with Vahid.

### RX5. Opening Parchment sits on today's roles until the prescriber role lands

Decision: `prescribing:open` is a clinical-zone permission held by the owner and clinicians. When the staff-access roles land it moves to prescribers only.
Why: the clinical roles are being built alongside; until then a clinician is the nearest role to a prescriber, and the consult gate (RX1) still applies to whoever holds it.
