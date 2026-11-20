# Patients, patient sign-in and identity

Rulings for the identity part of the patient record, patient accounts and patient sign-in (PRD section 3). ADR 0035 sets the system-level rule; ADRs 0006, 0007, 0008, 0010 and 0028 apply throughout. Rulings marked "Decided by: stand-in" were decided by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### IDN1. One patient record per person per tenant

Decision: a patient record (`clinical.patients`) belongs to one tenant. The same person signing in at another tenant's brand gets a separate record there, linked to the same patient sign-in. Nothing is shared or visible across tenants: not the record, the identity check, the IHI nor the consents. Within a tenant, one record serves all its brands. Other tables reference `(tenant_id, patient_id)`, so they can never point at another tenant's patient.
Why: each tenant is the data controller and healthcare provider for its own patients. Matching people across tenants (by email, say) is how one clinic's record ends up in another's hands.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN2. Patients sign in on their own instance, and act as themselves

Decision: patient routes accept only tokens from the patient sign-in instance (ADR 0035), carrying a session id (`sid`). A patient changing their own record is recorded as `actor_type = 'patient'` with their patient id. Creating the account is audited as the new patient. Clerk holds the email, mobile and sign-in methods only.
Why: staff sign-up stays closed while patients sign themselves up; one kind of token can't open the other door; the audit log says who really acted.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN3. The date of birth is confirmed on every new sign-in session

Decision: a patient route answers 403 `date_of_birth_needed` until the current sign-in session has confirmed the patient's date of birth (`POST /v1/patient/confirm-date-of-birth`), stored in `clinical.patient_sign_ins` against the session id. Creating the account confirms the session it was made in. Five wrong dates per patient in 15 minutes answer 429 until the window passes. Each wrong date writes `patient.date_of_birth_refused`, committed before the refusal.
Why: IDN-07 asks for the date of birth on first use, as a second thing only the patient knows on top of the one-time code. Checking it per session in the backend means no screen can skip it.

### IDN4. Until brands exist, a patient request names its tenant

Decision: a patient request names its tenant in `x-medora-tenant`, set by the patient app's server, not typed by the patient. A tenant that doesn't exist answers 403 `tenant_unavailable`. When brands land, the brand's host (`x-medora-brand-host`, resolved to a live or paused brand) replaces it, and new sign-ups stop on a paused brand.
Why: brands are being built in parallel. The tenant id is not a secret worth guarding here: anyone may sign up with any tenant's service, so naming one reveals nothing.
Replaced by: a later ruling when the brand host is wired in.

### IDN5. Medicare is optional, checked and sealed

Decision: a Medicare number is optional. It must pass the card's check digit (10 digits, first digit 2 to 6), with an optional single-digit reference number and a valid-to month. Number, reference number and valid-to are sealed together in `clinical.patients.medicare` with field encryption (ADR 0010) and shown masked to the last four digits. Prescribing reads the full value through `getPatientForPrescribing`, which audits `patient.read_for_prescribing`.
Why: IDN-04 makes Medicare optional; a typo found on entry is cheaper than a rejected script; Medicare numbers are masked everywhere except where a role needs them (GOV-10).

### IDN6. Legal details lock once identity is verified

Decision: a patient may change their legal names, date of birth and sex only while their identity is unverified. Once verified, the change is refused with `identity_locked`, and support changes them with a reason and a new identity check. The preferred name is separate and always editable; screens use it when set.
Why: a verified identity that the patient can then edit proves nothing.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN7. The home address is collected for scripts

Decision: the patient's home address (`clinical.patient_addresses`, kind `home`) is part of their identity details and is collected in onboarding, before the consult. Delivery addresses belong to orders.
Why: every Australian script carries the patient's address, and prescribing happens before any order. The stand-in suggested collecting the address only at ordering; that would leave the prescriber without it.
Decided by: this build, against the stand-in's suggestion; to confirm with Vahid

### IDN8. Adults only, on the tenant's calendar day

Decision: a patient must be 18 or older when the account is created, worked out against today's date in the tenant's time zone. Dates that aren't real, are in the future, or are more than 120 years ago are refused. A protocol may set its own age limits as rules.
Why: IDN-03 limits v1 to adults; "today" must be the tenant's day, not UTC's (ADR 0017).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN9. Staff see identity with `patients:read`, and every patient shown is audited

Decision: `GET /v1/patients`, `GET /v1/patients/:patientId` and a patient's consents need `patients:read`; recording a consent for a patient needs `patients:manage`. `patients:read` is held by owner, tenant admin, medical director, prescriber, clinician and support, and `patients:manage` by owner, tenant admin and support; finance, operations, marketing and compliance hold neither. The tenant admin holds both because someone can give only a role whose permissions they all hold (ADM4), and the tenant admin invites support staff. They show identity and contact details (Medicare masked) and consent decisions, never intake answers or notes, which need their own clinical-zone permissions. A list writes one `patient.listed` entry per patient shown; opening a record writes `patient.read`. Searching by contact writes one `patient.searched` entry with the count only.
Why: support needs to know who they are helping without seeing clinical content; a name in a list is still a read of that patient's record (ADR 0008).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN10. The patient record is in the clinical zone

Decision: patients, their contacts, addresses and sign-in checks are in the `clinical` schema. Marketing learns a patient's contact details only after marketing consent, through the messaging module's own records.
Why: in a health service, a patient's identity is health information; the marketing role can't reach the clinical schema at all (ADR 0007).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN11. An email and a mobile, one row each

Decision: contact details are rows in `clinical.patient_contacts`, one per kind for now: the email lowercased and the mobile as an Australian E.164 number (`+614…`). The contact the sign-in proved is stored with `verified_at`; one typed in has none. They are stored plain, so staff can find a patient by them.
Why: ADR 0028 keeps repeated things in rows; exact, normalised values make "find by contact" reliable for inbound messages.

### IDN12. Each consent is asked when it is needed, against an exact version

Decision: a tenant publishes the text of each kind of consent as numbered versions (`clinical.consent_documents`): `privacy` (privacy and the collection of health information), `telehealth_terms`, `identity_check` and `pharmacy_sharing`. A patient's decision is a row against one exact version (`clinical.patient_consents`): the kind, given or withdrawn, when, and how (`web`, or `phone` and `in_person` when staff record it, with who and why). Each is asked where it is needed, not bundled: privacy at the start of an intake, telehealth terms when the account is created, identity check at the check, pharmacy sharing before the first order. Marketing consent is per brand and is the messaging module's (`recordMarketingConsent`), not a kind here.
Why: a record of consent is only worth something if it says exactly which words the patient agreed to; consent asked at the moment it matters is consent the patient understood.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN13. A new version asks again, and blocks new care until it is given

Decision: a kind is needed unless the patient's latest decision on it is "given" on the tenant's current version, so publishing a new version asks every patient again. A kind the tenant hasn't published is needed too, so care can't start until the tenant has published its privacy text and terms. Other modules call `assertConsents(tx, patientId, purpose)` from the front door before starting an intake or booking a consult (`care`: privacy and telehealth terms) and before an order (`order`: those plus pharmacy sharing); it refuses with 409 `consent_needed` and the kinds still needed. It never blocks the patient reading their own record, messaging or cancelling. A patient gives consent in the patient app; withdrawing a required consent goes through support in v1 (`POST /v1/patients/:patientId/consents`, with a reason), keeps the record, and emits `consent.withdrawn` so other modules can pause care. Only the current version can be given; a decision the same as the latest one adds no row.
Why: an outstanding new version of a required consent must stop new care, but a patient must never be locked out of their own information or of stopping.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN14. Published consent text and consent decisions never change

Decision: both tables are insert-only. The API's role has SELECT and INSERT only, and a trigger refuses any update, delete or truncate from every role, the owner role included. A correction to the text is a new version; a withdrawal is a new decision. A decision's kind is checked against its document's by the foreign key. Publishing needs `consents:manage` (owner and tenant admin); reading the documents needs `patients:read`. The consent text is plain text with blank lines between paragraphs, never drawn as HTML.
Why: consent records are evidence; evidence that can be edited isn't evidence (ADR 0008).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### IDN15. A permission's zone is what it shows, not where its rows live

Decision: `patients:read` and `patients:manage` are `operational`-zone permissions, although the rows they show are in the `clinical` schema: they show who the patient is, how to reach them and their consent decisions, which support, orders and billing need without break-glass. Every key that shows clinical content (intake answers, protocols' patient results, notes, scripts, care plans) is a separate key in the `clinical` zone, so it works only for a clinical role or under break-glass. `consents:manage` is `platform`: it publishes the tenant's own text and shows no patient.
Why: the data zone of a permission decides who may use it without break-glass (admin rulings); marking identity clinical would put every support call behind break-glass, while the rows staying in the clinical schema still keeps marketing code from reaching them (ADR 0007, IDN10).
Decided by: stand-in (Fable 5.2), to confirm with Vahid
