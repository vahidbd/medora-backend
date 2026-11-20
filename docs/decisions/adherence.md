# Adherence: the activity stream and adherence flags

Rulings for how Medora sees whether a patient is keeping up with their program, and what it shows the care team (PRD 12: ADH-01, ADH-02). ADR 0260 sets the rules every module follows; ADRs 0006, 0007, 0008, 0016, 0017 and 0028 apply throughout. What the patient records is in `tracking.md`; the console's screen is in medora-front's `docs/decisions/adherence.md`. Rulings marked "Decided by: stand-in" were decided by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### ADH1. Activity is what the patient did, and only that

Decision: the adherence activity stream holds the patient's own actions, one row each: `app_opened`, `measurement_recorded` (readings taken together are one), `side_effect_reported`, `check_in_submitted`, and `message_sent` and `order_placed` for the support and orders modules to write. Each row points at the record the action wrote. A reading, report or message a staff member or an agent adds for the patient is not the patient's activity and writes none. The module that does the action calls `recordActivity` in the same transaction (ADR 0260); each row writes its own audit entry with the patient's id and the kind.
Why: the stream answers "is this person still engaged?", which only their own actions can. Naming the two coming kinds now saves the threads writing them a migration each.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### ADH2. Opening the app counts once a day, on the patient's calendar

Decision: the patient app calls `POST /v1/patient/activity/app-opened` each time the signed-in app loads. The first call on a calendar day, in the patient's time zone or else the tenant's (ADR 0017), writes an `app_opened` row; the rest write nothing and answer the same. A unique index on the patient and that day holds it, so two tabs opening together still write one row.
Why: "logins" are a signal of engagement, not a count of page loads, and the day that matters is the patient's.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### ADH3. Activity and adherence flags are clinical, and kept

Decision: both tables are in the clinical zone. Activity is never changed or removed: the API's role may only read and add it. Adherence flags are never removed. Nothing in marketing reads either; a nudge that needs activity gets a named, derived event under its own ruling.
Why: that someone is a brand's patient, and how they keep up, is health information (ADR 0007).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### ADH4. A side effect's adherence flag is raised with the report, one per report

Decision: reporting a side effect raises its adherence flag in the same transaction, whoever reports it, the patient or a staff member for them. The flag points at the report by a foreign key, and a unique index allows one flag per report, so raising it twice changes nothing. Raising writes an audit entry and an `adherence_flag.raised` event with the patient's id, the kind and the urgency only. `side_effect.reported` still goes out for governance.
Why: delivery of events can lag or stop; a severe report without its flag is the one state this feature must make impossible. The person recording a side effect is not always the person who acts on it.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### ADH5. How soon a side effect is looked at depends on its severity

Decision: a severe report raises an `urgent` adherence flag, a moderate one a `soon` flag, and a mild one none (it is activity only). Urgency is one of `urgent`, `soon` and `routine`, one list in `values.ts` that the clinician task inbox reuses when it is built.
Why: TRK4 says severity decides how fast someone looks. A moderate report nobody is prompted to read is the riskier mistake; the cost of over-flagging is one "no action needed".
Decided by: stand-in (Fable 5.2), to confirm with Vahid with the medical reviewer, since it is a triage threshold

### ADH6. Nobody is paged yet

Decision: raising an adherence flag notifies no one. Urgent flags wait in the console's list, which shows how long each has been open, for the next person to look. Who is told about an urgent flag out of hours, and how fast one must be looked at, is for the product owner, and is a line in `docs/launch-checklist.md` before the first patient.
Why: paging is a staffing and liability decision, not a code one. The patient app already tells the patient that a report reaches no one straight away, and to call 000 if it can't wait (TRK4).
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### ADH7. Resolving says what was done, and a mistake is undone by reopening

Decision: a staff member resolves an open adherence flag with an outcome, one of `contacted_patient`, `booked_review`, `referred_to_prescriber` and `no_action_needed`, and an optional note of up to 1,000 characters. The note is clinical text, kept like the patient's words: never in an audit detail or event. Resolving a resolved flag is refused. A resolved flag and its resolution are never changed: a mistaken resolution is undone by reopening, which raises a new open flag for the same report and urgency, linked to the earlier one. A flag is reopened once at most; after that its reopening is the one to resolve or reopen. The database holds all of this for every role.
Why: editing the resolution would destroy what someone wrote about a patient (ADR 0028); having no way back would leave a severe report resolved by a slip with no open flag.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### ADH8. Agents know which adherence flags are open, never what the patient wrote

Decision: `openFlagsOf(tx, patientId)` gives the kind, urgency and when each open flag was raised, urgent first, and audits the read. It is how the care coordinator agent learns a patient has one. No agent resolves or reopens a flag, or reads the words behind one.
Why: the PRD makes clinical escalation human only, and ADR 0012 wants that enforced by the system, not by a prompt.
Decided by: stand-in (Fable 5.2), to confirm with Vahid
