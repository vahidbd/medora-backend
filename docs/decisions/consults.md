# Consults

Rulings for consults, their evidence and the consult gate (ADRs 0005, 0006, 0008, 0009, 0020, 0029, 0120). `src/modules/consults/`, tables in the `clinical` schema. Booking, the phone flow and the video room service add their rulings here as they land.

Rulings marked "Decided by: stand-in" were made while the product owner was away and are to be confirmed with him.

### CNS1. A consult is a real-time phone or video call, and nothing else

Decision: a consult's mode is phone or video. Chat, messages, forms and AI voice calls are never consults and never count towards a script.
Why: ADR 0009 needs a real-time consult with the prescriber, and ADR 0020 keeps AI voice calls out of it.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS2. Evidence comes only from verified provider callbacks, and is never changed

Decision: consult evidence is one row per "connected" or "disconnected" event for the patient or the consult's clinician, at the provider's time. Every row points at the stored webhook delivery it came from, by a key that includes the tenant, so evidence exists only where a provider's signed callback said so. The delivery can't be removed while evidence points at it. A delivery gives at most one row per party. The API may only read and add rows, and a trigger refuses any change or removal from any role. No route, agent tool or test helper writes evidence: tests send signed callbacks to the real webhook route with a test secret.
Why: the gate is only as good as its evidence. If anything but a verified callback could write it, a bug, a script or an agent could make a consult appear that never happened.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS3. A consult's status follows its evidence, and the gate never trusts it

Decision: a scheduled consult becomes in progress, with its start time, at the first moment the patient and its clinician were connected together, and completed when the provider says the room or call finished. Both happen in the same transaction as the evidence, audited, with `consult.started` and `consult.completed` events. A cancelled or no-show consult keeps its status whatever evidence arrives; the evidence is still recorded, because it is what happened. Evidence that arrives after a consult completed is recorded and counts. The gate works from the evidence and reads the status only to leave out cancelled and no-show consults.
Why: the status is for screens and booking. The gate's question, "were they really talking", has one answer, and it is in the evidence.
Open for booking: reinstating a no-show, and refusing to cancel a consult a script relies on.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS4. Only time closed at both ends by the provider counts

Decision: time together counts only once a provider timestamp ends it: either party leaving, or the room or call finishing. Time with no end yet counts for nothing, towards the minimum and the window. Time together is found within each channel (a patient on the phone and a clinician in the video room are not together), then merged, so a video call that falls back to phone is one consult with one evidence log and no time counts twice. A consult qualifies at the disconnect that completes the minimum.
Why: if open time counted, a lost "left" callback would let ten real seconds pass as an hour.
Consequence, for Vahid: a script can't be written while the call is still open; the clinician prescribes after the patient or they leave. If prescribing during a call is wanted, the phone and video pull requests can add a live check with the provider. Not assumed now.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS5. The provider's clock counts, not when we heard about it

Decision: evidence carries the provider's time for the event, as given (the video server sends whole seconds), with no rounding either way. The time we stored the callback is kept in the inbox for diagnosis only. A provider time more than 30 seconds after we received the callback makes no evidence. A connect and a disconnect in the same second are read connect first, so a blip closes at once instead of staying open.
Why: callbacks can be delayed, retried or arrive out of order; the provider's time is when it happened. A time in the future is a clock fault or a forgery, and neither should prove anything.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS6. At least 60 seconds together, usable for 24 hours after they were last together

Decision: a consult qualifies once the patient and that clinician have at least 60 seconds of proven time together, in total. It is usable from then until 24 hours after the last proven moment together, which is never later than the consult's end, so a consult stuck "in progress" can't stay usable. A tenant may raise the 60 seconds or shorten the window, never the reverse; the setting arrives with booking, where tenants get consult settings, and the database will refuse values past the floor. Until then the floor (`CONSULT_GATE_FLOOR`) applies to everyone.
Why: 60 seconds is long enough that a wrong number or a voicemail greeting doesn't pass, and a day covers a clinician finishing their notes and scripts after a clinic session.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS7. Video rooms and people are named by ids that Medora sets

Decision: a video room is named `consult:<tenant id>:<consult id>` and a participant's identity is `patient:<patient id>` or `clinician:<user id>`, set by Medora in the join tokens it signs (ADR 0120). The video server's webhooks come to one address for every tenant, and the tenant comes from the room's name, so no lookup across tenants is needed. Only the consult's own patient and clinician are evidence; an interpreter or a second clinician is not, so nobody qualifies themselves by joining another clinician's consult. Callbacks for other rooms, other events or unknown tenants are answered and dropped. No names go to the video server.
Why: "that clinician" must be provable from the evidence, and a server that serves every tenant must not need a privileged lookup to find one.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS8. The gate check is audited every time and runs on the database's clock

Decision: `findQualifyingConsult` returns the consult that lets this clinician write this patient a script now, or nothing. It also checks that the clinician is a prescriber in good standing at that moment, as the contract with prescribing promised. Every call writes an audit entry with ids only: the clinician, whether a consult was found, which, and when not, a reason code (`no_consult`, `too_short`, `window_closed`, `not_a_prescriber`). Its time defaults to the database's clock and is never later than it. Opening the prescribing system leaves it out, so nothing can be backdated; reviewing a script that came back without a consult passes the time the script was written, so only a consult that qualified before then can be linked. `listQualifyingConsults` lists every consult with enough time together, whatever the window, for a reviewer linking a script by hand; standing is the caller's to check there.
Why: the check reads clinical data (ADR 0008), and a reason in the audit lets a medical director see why a script was refused without putting anything clinical in it.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### CNS9. The script side of the gate belongs to prescribing

Decision: scripts are written in Parchment and come back by webhook (ADR 0013), so the database can't refuse one without losing the record of a script that exists. The gate is enforced where Medora acts: a prescribing session carries the qualifying consult's id, not null, and is opened only after this check and the prescriber's own standing check pass. A script that comes back without a session's consult is stored, flagged to the medical director (ADR 0009), and can't be ordered, charged or dispensed. Those rulings are prescribing's (RX1, RX6, RX8, RX10).
Why: written down here so the two halves of the gate are visibly one rule, and neither falls between pull requests.
Decided by: stand-in (Fable 5.2), to confirm with Vahid; amended after prescribing's rulings, with ADR 0013 in view.

### CNS10. "Recorded" means the evidence record, not a recording

Decision: a "recorded real-time consult" (ADR 0009) is one with consult evidence. Nothing here captures audio or video; recording needs the patient's consent for that consult (ADR 0020) and its own ruling.
Why: the word appears in both senses, and only one needs consent.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.
