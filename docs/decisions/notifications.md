# Notification preferences

Rulings for how a patient chooses to hear from their care (PRD 11, APP-06). The CRM thread's sender reads them through `notificationPreferencesOf` before it sends anything to a patient. ADRs 0006 and 0007 apply; ADR 0100 says who the patient is. The patient app's screen is in medora-front (`docs/decisions/patient-app.md`). Rulings marked "Decided by: stand-in" were decided by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### NTF1. Email always, texts if the patient wants them

Decision: a patient's care always reaches them by email, the address they sign in with; there is no switch for it. Texts to the mobile on their record are on until the patient turns them off. A patient with no mobile on record gets no texts whatever the switch says. Marketing is not here: it needs its own consent, in the marketing zone (ADR 0007).
Why: a patient who could turn every channel off would miss a care team's reply or a script that needs them, with no one knowing. One channel that can't be turned off is the smallest rule that prevents it, and email is the one every patient has.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### NTF2. Reminders can be turned off; what the care team writes can't

Decision: reminders (to check in, record a reading, reorder) are on until the patient turns them off. Messages a person writes, and notices the patient must act on (a script issued, a payment that failed, a shipment held), are not reminders and always go.
Why: reminders are the app nudging; a care team's message is care. Muting the second would hide something a clinician meant the patient to read.
Decided by: stand-in (Fable 5.2), to confirm with Vahid

### NTF3. The defaults are code, a row is only a change

Decision: no row means the defaults (texts on, reminders on). The patient's first change writes a row, later changes update it, and each change writes an audit entry with the two choices. Preferences are operational: they say how to reach someone, not anything about their health. The API may read, add and change them, never delete them.
Why: patients who never open the setting cost nothing, and the audit trail shows when someone stopped getting texts.
