# Intake and the protocol engine

Rulings for protocols, their versions and sign-off, programs, and intakes (PRD section 2). ADR 0023 sets the rule that conditions, protocols and their questions are tenant data, never code; ADRs 0006, 0007, 0008, 0009, 0010, 0012 and 0028 apply throughout. Rulings marked "Decided by: stand-in" were decided by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### INT1. One small rule language, run on the server

Decision: a protocol version is data: steps of questions, derived numbers and rules (`src/modules/protocols/definition.ts`). A condition is `all`, `any` or `not` over comparisons (`equals`, `not_equals`, `less_than`, `at_most`, `greater_than`, `at_least`, `one_of`, `includes`, `answered`) on an answer or a derived number. A derived number is add, subtract, multiply or divide over number answers and other derived numbers, rounded to the decimals the protocol gives; `age`, worked out from the date of birth, is the one built-in. Steps and questions can carry a show-if in the same language, reading only earlier steps. Free text never drives a rule or a show-if. There is no scripting, and rules run only on the server. A definition that breaks any of this is refused with each problem's path (400 `protocol_problems`).
Why: BMI and every threshold stay data a medical director can read and sign, so a new condition is a new protocol, not a code change. A language this small can be checked completely before a version goes live, and a rule never sees text a patient typed.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT2. Two outcomes: hard stop and red flag

Decision: a rule is either a hard stop or a red flag. A hard stop ends the intake as ineligible and must carry a message for the patient in plain words, with no diagnosis; it may also carry `urgentHelp`, which shows the emergency and crisis lines. A hard stop is checked after every step, but only once every question it reads is on a finished step, and the first that holds ends the intake. A red flag lets the intake go on and gives the prescriber a label written in the protocol; it is never shown to the patient. There is no "needs review" outcome and no staff override of a hard stop; a new intake is the way back, and the prescriber sees the earlier ones.
Why: every patient sees a prescriber in real time before any script (ADR 0009), so a pre-booking review queue would be machinery with no gap to fill. Checking a stop only once its questions are behind the person means it never fires on an answer that isn't given yet.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT3. Versions: one draft, one live, and signed-off versions never change

Decision: a protocol has numbered versions. Version 1 is made with the protocol, as a draft. Only a draft is edited, and a protocol has at most one draft and one live version at a time (partial unique indexes). Starting a new draft copies the newest version. Signing off a draft makes it live and retires the live one. A version's status moves only draft to live, then live to retired or withdrawn; its definition and sign-off never change after it leaves draft, and no version is deleted. A database trigger holds this for every role, not only the API. An intake pins the version that was live when it started and finishes on it, even if a newer one goes live meanwhile.
Why: a prescriber must be able to see exactly which rules a patient answered, months later. A trigger keeps that true even against a mistaken script run as the owner.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT4. A medical director signs off, under their registration, and can withdraw

Decision: signing off needs `protocols:sign_off`, which the medical director role holds. It is a clinical permission, so an owner who is not in a clinical role can use it only with break-glass open (ADM3). The signer is always a person, never an agent, and may sign a draft they edited. They give their Ahpra registration as a medical practitioner (`MED` and ten digits) and confirm the attestation, which is stored with the version: "I have reviewed version N of the protocol "name" and approve it for use with patients, under Ahpra registration MED…". Until the staff record holds each clinician's registration and standing, the signer types it at sign-off; once it does, sign-off reads it from there and refuses a signer without current standing. A medical director can also withdraw the live version for safety, with a reason: new intakes stop, intakes in progress on it end and must restart, and completed intakes not yet consulted show the prescriber that their version was withdrawn.
Why: a non-clinical owner must not be able to put clinical rules live, and the platform can't make the owner a clinician by granting a role (ADR 0030 lets a person grant only what they hold). Recording the registration ties the sign-off to a person with standing to give it. Whether a nurse practitioner may hold the post is a question for legal; for now the signer is a medical practitioner.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT5. An intake can start before an account

Decision: a person can start an intake on a brand site before having an account. The first screen is the collection notice with consent to collect health information (the tenant's current privacy document, recorded on the intake by version and time) and a confirmation that they are 18 or older. The date of birth is the first question; under 18 ends the intake there (`ended`, `under_age`), before any health answer is collected. The intake is held by a resume token. The API sends it once, in the `x-medora-intake-token` header of the reply that starts the intake and never in a body; the patient app's server moves it into an httpOnly, Secure, SameSite=Lax cookie on the brand's host and sends it back in the same header. Only the token's SHA-256 hash is stored. An anonymous request names its tenant in `x-medora-tenant`, as a patient's does (IDN4). Starting is rate limited per address and per tenant, and wrong tokens per address, so a token can't be guessed. No attribution or tracking is stored on an intake, and intake pages carry no third-party script (ADR 0022).
Why: the PRD journey is quiz first, then account. Consent on the first screen meets APP 3 and APP 5 before any health information is collected.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT6. Signing up claims every intake started in that browser

Decision: when the person signs up or signs in, every intake held by that browser's tokens becomes theirs, including ineligible ones. The privacy consent given on the intake's first screen becomes the patient's privacy consent, with the intake's version and time, so they aren't asked twice. The token hashes are cleared on claim. Claiming needs a patient record, so the account's date of birth is the one the person gives when they create it; when it isn't the intake's, the prescriber's summary says so (INT15).
Why: otherwise a person could answer until they pass and then sign up, and the prescriber would never see the earlier answers.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT7. Unclaimed answers are kept for 14 days

Decision: an intake nobody claims has its answers and date of birth cleared 14 days after its last activity; the row stays with `cleared_at` and status `ended`, `unclaimed`, so counts still add up. A claimed intake is part of the patient's clinical record and is never deleted (ADR 0028). A claimed intake still in progress after 30 days without activity ends as `expired`, with its answers kept. The privacy impact assessment confirms the 14 days.
Why: unclaimed answers are health information with no care attached, so they are kept only as long as is useful (APP 11.2). An unclaimed intake is not yet anyone's clinical record, so clearing it doesn't break ADR 0028.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT8. What an intake's status says, and what leaves the clinical zone

Decision: an intake is `in_progress`, `completed` (submitted), `ineligible` (a hard stop ended it, and the rule is recorded) or `ended` (with a reason: `under_age`, `version_withdrawn`, `expired` or `unclaimed`). Answers overwrite while it is in progress; a completed or ineligible intake never changes, and a correction is a new intake or a note in the consult. Answers are sealed with field encryption (ADR 0010). The events `intake.started`, `intake.completed` and `intake.ended` carry the intake, the program and the status (and why an intake ended, from the reasons above), and `intake.completed` the patient: never an answer, a red flag or the rule that stopped it.
Why: the stopping rule and red flags are clinical; the acquisition and support modules need to know an intake ended, not why.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT9. A program is one brand's offer on one protocol

Decision: a program belongs to one brand and uses one protocol, and inherits the protocol's condition rather than storing its own. A tenant selling the same care under two brands makes two programs on one protocol. A program is a draft, live, paused or retired: draft goes live or is retired, live pauses or is retired, paused goes live again or is retired, and retired is final. It can go live only while its protocol has a live version. Withdrawing the protocol's live version doesn't change the program's status, but no intake can start on it until a new version is signed off. A program lists what its patients record (`measurements`) and how often they check in. Programs are operational: any staff member can read them, and billing puts prices on them.
Why: brand sites and billing show programs, so they can't be clinical; the clinical rules stay on the protocol. One brand per program keeps prices and copy per brand without a second join table.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT10. Protocol templates are reviewed data files in the repo

Decision: the platform's protocol templates are JSON files in `src/modules/protocols/templates/`, checked against the protocol rules when the API starts (a bad file stops it). A tenant copies one into a draft of its own, and the tenant's medical director still signs off their copy. Each template records the medical practitioner who reviewed it for Medora (`clinicalReview`), or null while it is a draft for review; the console shows that. Code never branches on a template, and tests use made-up conditions. The weight-management template ships unreviewed, with the stand-in's rules: 18 to 75; BMI 30 or more, or 27 to 29.9 with a weight-related condition; hard stops for current thoughts of self-harm (with the urgent-help message), pregnancy, medullary thyroid cancer or MEN2, pancreatitis, type 1 diabetes, a current eating disorder, weight-loss surgery in the last 12 months and a serious reaction to a weight-loss medicine; red flags for 65 to 75, implausible height or weight, gallbladder, kidney, liver or diabetic eye disease, severe gut disease, depression, a past eating disorder, earlier surgery, earlier weight-loss medicine, glucose-lowering medicine and treatment elsewhere. No medicine is named.
Why: templates change rarely, are written by the platform, and deserve the same review as code, so a pull request is the right place. A platform table would add a seed path and an admin screen for no one. This replaces the stand-in's suggestion of a platform table.
Decided by: stand-in (Fable 5.2) for the rules, to confirm with Vahid; the file-not-table choice is ours, also to confirm

### INT11. Who reads and changes protocols, programs and intakes

Decision: `protocols:read` is held by the owner, the tenant admin, the medical director, prescribers and clinicians. `protocols:manage` (start and edit drafts) by the owner and the medical director. `protocols:sign_off` as in INT4. `programs:manage` by the owner, the tenant admin and the medical director. `intakes:read` (a patient's answers and the prescriber's summary) by the medical director, prescribers and clinicians, and by an owner only with break-glass; support sees an intake's status through `patients:read`, never its answers. Support and finance get no protocol permission. No agent drafts protocols or programs yet; the tenant setup agent will use these same routes (ADR 0012), and no agent ever signs off or withdraws.
Why: drafts are harmless because nothing goes live unsigned, so the people who run the service may write them; answers are clinical and stay with clinical roles.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT12. Steps are saved one at a time, and only a patient submits

Decision: answers are saved a step at a time, and a step can be answered only once every shown step before it is done (409 `step_not_reached`). A step's answers are checked together: a missing required answer, a wrong kind or a number out of range is refused with each question's problem (400 `answer_problems`) and nothing is saved. Going back to change an earlier step keeps the later answers that are still shown, drops the ones it hides, and moves the intake back to the first step that is no longer finished. Only a signed-in patient with their care consents submits; an anonymous intake that is finished waits, ready, for the person to sign up and claim it. Submitting checks the hard stops again with every step done, then records the red flags as they stand. A patient who starts a program they already have an intake in progress for gets that intake back.
Why: saving each step lets a person stop and come back, and refusing a skipped step keeps every hard stop in front of the questions it guards. A submit is the request for a consult, so it belongs to a person the clinic can identify and has consent from.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT13. Age is worked out on the tenant's calendar

Decision: "today" for a date of birth's checks and for `age` in the rules is the date in the tenant's time zone (ADR 0017). The prescriber's summary shows the age on the day the intake was submitted, or ended by a hard stop, so it matches what the rules saw.
Why: a person who turns 18 today in Perth is still 17 in UTC for part of the day; the rules and the prescriber must agree on which day it is.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT14. Lapses happen when an intake is next touched, and a sweep clears the rest

Decision: the 14-day clear, the 30-day expiry and the end of intakes on a withdrawn version (INT4, INT7) are applied whenever an intake is opened, answered, claimed, submitted or summarised, in a transaction of their own before the request's work, so a refusal that follows can't undo them. A scheduled sweep applies them to intakes nobody opens; until the API has a job runner it is a launch gate (`docs/launch-checklist.md`).
Why: applying a lapse when it is read means nobody ever sees an intake that should have lapsed, without waiting for a job. The sweep is still needed so unclaimed answers are cleared on time even when nobody comes back (APP 11.2).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT15. The prescriber's summary

Decision: a completed intake, and one a hard stop ended, has a summary for whoever holds `intakes:read` (INT11): the protocol and version it was answered on (and whether that version was withdrawn), the outcome (`clear`, `red_flags` or `ineligible`), the answers in question order with the labels the patient saw, the ones behind a red flag marked, the derived numbers, the red flags and stopping rule in the protocol's words for the prescriber, and the patient's earlier ineligible intakes with the rule that stopped each. It is marked stale when answered more than 30 days before today, and says when the date of birth on the intake isn't the one on the patient's record. Every read writes an audit entry. Staff see a patient's intakes and where each stands, without answers, through `patients:read`.
Why: the prescriber decides in the consult with the whole picture, including what a patient answered before they passed. Thirty days is when a weight or a medicine list is likely to have moved enough to ask again.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### INT16. A brand's site lists its open programs

Decision: `GET /v1/public/brands/:brandId/programs`, with the tenant in `x-medora-tenant`, lists the brand's programs a person can start now: live, on a protocol with a live version. It answers as an intake's start does while the brand isn't taking new patients (409 `brand_not_accepting` or `tenant_not_ready`). Each program gives its id, name and condition, nothing else; brand copy about a program lives with the brand site's content, not on the program.
Why: the start screen needs something to offer when a person arrives without a program in the link. Programs are operational and public by nature, so listing them reveals nothing a brand site wouldn't show.
Decided by: us, at the patient intake screens thread's request, to confirm with Vahid

### INT17. A claimed intake started with another date of birth is kept from the patient

Decision: claiming still takes every intake the browser held (INT6). When a claimed intake's date of birth isn't the one on the patient's account, the patient can't open, answer or send it: the API answers 409 `date_of_birth_differs`, and the patient app says to start a new one. Starting a program again picks up only an intake with the patient's own date of birth. The intake stays on the record, and the prescriber's summary shows it with the date of birth flagged (INT15). Whether resuming an anonymous intake should ask for the date of birth first is for the privacy impact assessment.
Why: on a shared device, the next person to sign in would otherwise read the last person's answers. Keeping the row still shows the prescriber what was answered in that browser.
Decided by: stand-in (Fable 5.2), raised by the patient intake screens thread, to confirm with Vahid
