# Tracking: measurements, side effects and check-ins

Rulings for what a patient tells their care team between consults (PRD 11 and 12: APP-03, ADH-01, ADH-02). ADRs 0006, 0007, 0008, 0016, 0017 and 0028 apply throughout; ADR 0035 says who the patient is. The patient app's screens are in medora-front (`docs/decisions/patient-app.md`). Rulings marked "Decided by: stand-in" were decided by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### TRK1. One table for every measurement, each kind in one unit

Decision: `clinical.measurements` holds every kind: `weight` (kg), `waist` and `height` (cm), `blood_pressure_systolic` and `blood_pressure_diastolic` (mmHg, always recorded together, the first higher), and `heart_rate` (bpm), to one decimal place. Each kind has a range a real reading falls in, and anything outside it is refused as a typing slip. A new kind is a value in `MEASUREMENT_KINDS`, its unit and range, and a migration. The care team's chart reads the same table through `measurementsOf`.
Why: one place for every reading means one chart, one audit trail and one set of rules, and a fixed unit means no reading is ever read in the wrong one.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### TRK2. A reading is dated when it was taken

Decision: a reading carries the moment it was taken, which may be up to 30 days before it is recorded and never in the future (five minutes' clock drift allowed). Readings sent together share that moment.
Why: patients weigh themselves in the morning and record it later; a chart by recording time would be wrong. A limit stops a slip of the year putting a reading where no one will see it.

### TRK3. The patient or their care team records, and nothing is changed afterwards

Decision: a measurement or side effect is written by the patient on their own record or by a staff member for them, never by an agent or the system, and each row says which (`recorded_by_type`, `recorded_by_id`). The patient sees "you" or "your care team", never a staff member's name. Rows are never changed or deleted (ADR 0028), and the API's database role can only read and add them: a wrong reading is followed by a right one.
Why: what a clinician acts on must be what the patient said, and who said it.

### TRK4. A side effect is the patient's words and how bad it is

Decision: a side effect report is free text (up to 2,000 characters), a severity (`mild`, `moderate` or `severe`) and, if the patient knows, the day it started. The words stay in the record: audit details and the `side_effect.reported` event carry the patient's id and the severity only. A severe report raises an urgent adherence flag for the care team, and the patient app tells the patient, before they send it and after, to call 000 or go to an emergency department if it can't wait. No medicine names or doses are written in code or fixtures.
Why: patients describe side effects in their own words, and a fixed list misses what matters. Severity is the one fact that decides how fast someone looks, and the patient app must never make a report feel like an emergency service.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### TRK5. A check-in is a few answers, written all together

Decision: a check-in asks whether any doses were missed since the last one (`none`, `some`, `most`) and how the patient feels overall (1 to 5), and can carry readings and one side effect. It is written in one transaction, so a check-in is never half there. It has no free-text note: anything the patient wants to say goes to Messages, which a person answers. Dose-by-dose logging waits for a dose interval in the program or care plan; scripts carry none.
Why: a short check-in gets answered; a note in a check-in could hold something urgent that nobody is waiting to read.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### TRK6. When a check-in is due

Decision: a check-in is due a program's `checkInEveryDays` after the last one (or after the account was created), on the patient's calendar: their own time zone, else the tenant's (ADR 0017). The patient app shows it from the patient's programs. Flagging a missed check-in for the care team waits for programs and the job runner.
Why: the cadence is program data (ADR 0023), never code.
