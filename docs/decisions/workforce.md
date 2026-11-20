# Workforce

Rulings for clinicians, their credentials, and when they work (ADRs 0006, 0007, 0008, 0009, 0017, 0030). `src/modules/clinicians/`, tables in the `operational` schema.

Rulings marked "Decided by: stand-in" were made while the product owner was away and are to be confirmed with him.

### WRK1. A clinician is a staff member with a profession, and the profession sets what they must hold

Decision: a clinician is one membership in one tenant with one profession: medical practitioner, nurse practitioner, registered nurse, pharmacist, dietitian, psychologist or health coach. Every profession but health coach holds a registration: with Ahpra, or for a dietitian with Dietitians Australia (the APD credential). A registration records its type (general, specialist, provisional, limited), its status (practising, non-practising, suspended, cancelled), its conditions as the register shows them, and its expiry. Every clinician holds indemnity that says whether it covers telehealth with new patients. Only a medical practitioner, or a nurse practitioner with a current endorsement, may prescribe.
Why: the scope of what someone may do comes from their profession and the register, and the platform has to be able to say no before a consult is booked, not after a script is written.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### WRK2. Credentials are never rewritten, and an unchecked one doesn't count

Decision: a credential is a row that is added, checked and at most withdrawn (entered in error, replaced, or no longer held). It is never edited or deleted. Only a checked credential counts, and of those the newest held one per kind counts. A renewal waits beside the credential it renews, which keeps counting until someone checks the renewal; checking it withdraws the older ones of its kind as replaced. A clinician may withdraw their own credential while it is unchecked; once checked, only a manager can.
Why: the history of who held what, and who checked it, is the evidence a regulator or insurer asks for. Letting an unchecked renewal replace a checked registration would let anyone type their way into prescribing.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### WRK3. Standing is worked out when it is asked, and a lapse stops new work at once

Decision: whether a clinician may consult and prescribe is computed from their rows each time it is checked (`clinicianStanding`), with reasons for every "no". A credential counts until the end of its expiry day in the tenant's time zone. A registration that isn't practising, a suspended membership, or a "suspend now" by a manager blocks at once. A lapse stops booking new consults and starting them; it does not cut a call already in progress (the consults rulings say what happens to it). Lifting a suspension is its own action, by someone else.
Why: a stored "is active" flag goes stale the moment a date passes and needs a job to keep it true. Working it out from the rows means there is nothing to forget to run.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### WRK4. Nobody checks their own credential, and registration details are for managers

Decision: `clinicians:manage` lets someone add clinicians, change their profession, suspend and lift a suspension, check credentials and review a registration's conditions, never for themselves (`own_record`), whatever their role. A registration with conditions blocks consulting until a manager other than the clinician records that they have read the conditions and the work fits them. `clinicians:read` lets clinicians and support see every clinician's standing, hours and time off; registration numbers, conditions and policy details are shown only to managers and to the clinician themselves. A clinician records their own credentials, hours and time off. No agent tool does any of this.
Why: a check by the person being checked is no check. Conditions on a registration can be sensitive, and support only needs to know whether someone can be booked. A tenant whose only owner is its only clinician needs a second person before that clinician can see patients, and that is intended.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### WRK5. A check is dated, and goes stale after 31 days

Decision: checking a credential records who and when. A registration last checked more than 31 days ago shows "re-check due", and checking it again clears that; a credential ending within 30 days shows "expires soon". Neither blocks anyone. Checking against Ahpra's register is done by a person for now.
Why: the public register can change between renewals (a new condition, a suspension), so a monthly re-check is the smallest habit that catches it without an integration Ahpra doesn't offer.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### WRK6. Working hours are weekly blocks in the clinician's own time zone

Decision: a clinician's hours are blocks of a weekday, a start and an end, in the clinician's own time zone, each with its own slot length (15 minutes unless set). Blocks on one day never overlap. The week is replaced as a whole, with the clinician's row locked, by the clinician or a manager. Booking cuts slots from these and shows them to a patient in the patient's own time zone.
Why: a clinician in Perth working for a Sydney tenant thinks in Perth time; storing their hours in the tenant's zone would move them twice a year when only one side has daylight saving (extends ADR 0017).
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### WRK7. Time off is a period no slot may fall in, and can be taken away again

Decision: time off is a start and end instant with a reason (leave, sick, training, other), added and removed by the clinician or a manager. The detail screen shows time off that hasn't ended. Removing it opens those times to booking again; it doesn't restore consults cancelled because of it.
Why: time off is planned and changes; the way back out is deleting the period, which the audit log keeps a record of.
