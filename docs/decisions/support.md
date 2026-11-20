# Support

Rulings for the helpdesk (PRD section 13): tickets, triage, the clinical queue, replies, macros and the patient app's Messages. ADRs 0007 (data zones), 0008 (audit), 0009 (compliance in the system), 0012 (agents), 0027 (one owner per thing) and 0028 (records are never edited) set the rules; these record the choices made while building them. `src/modules/support/`. Sending email and SMS is in `messaging.md` (CRM).

Rulings marked "Decided by: stand-in" were settled by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### SUP1. The helpdesk's words

Decision: a **ticket** is one request from a person, across every channel they use for it. A **message** is one thing said on a ticket, in or out, on any channel. A **comment** is a staff note on a ticket that the person never sees. A **macro** is approved saved wording for a reply. A ticket sits in one **queue**: the support queue or the clinical queue. Support staff are staff, never "agents": an agent is one of Medora's own AI agents.
Why: one word per thing (GLOSSARY.md). "Agent" already means an AI agent, and the helpdesk is where the two meet.
Decided by: stand-in, to confirm with Vahid.

### SUP2. The clinical queue's text is hidden in the API, and only the clinical team sends a ticket back

Decision: `support:read` opens the support queue's text. A ticket in the clinical queue shows that it exists, its status and its flags to anyone with `support:read`, but its messages, comments and previews only to a holder of `support:clinical`; the API leaves them out of the reply (`textHidden: true`), the screen doesn't hide them. Every read of a ticket's text writes an audit entry in the clinical zone. Anyone who can read a ticket can send it to the clinical queue or make it urgent, and then loses sight of its text. Only a holder of `support:clinical` can send it back or lower it, never for a care-team ticket, and never while an emergency, self-harm or adverse event flag is open. Moving a ticket is audited with where it went from and to.
Why: people write health details into any support request, and the clinical queue is where they are certain (PRD SUP-02). Hiding on the screen only would leak through the API (ADR 0009). Sending a ticket to clinicians has to be one easy step for anyone, because word lists miss things; sending it back is a clinical judgement.
Decided by: stand-in, to confirm with Vahid.

### SUP3. Every message a person sends in is triaged by word lists

Decision: every inbound message on every channel, including chat and logged call summaries, is checked on its subject and body against the platform's word lists (`triage.ts`): emergency, self-harm, clinical, possible adverse event, possible complaint, legal and a request for a person. A ticket can carry several flags, and flags never clear on their own. Emergency or self-harm makes the ticket urgent and clinical; clinical words or a possible adverse event send it to the clinical queue. Triage only ever raises a ticket, never lowers it. A tenant can't remove a word. "Refund" isn't a complaint word.
Why: the same text always gives the same answer, and a list can be read and reviewed, which a model's judgement can't (PRD SUP-03). Checking every message, not only the first, catches the person who starts with an order question and then mentions chest pain. "Refund now" would flag half the billing queue as complaints.
Decided by: stand-in, to confirm with Vahid.

### SUP4. An emergency or self-harm message gets the safety reply at once

Decision: when triage finds emergency or self-harm words, the person gets the platform's safety reply straight away on the channel they wrote on, chat included: it says it is automatic, tells them to call 000, gives Lifeline's number and text line, and says the clinical team will read their message. A tenant can't edit it or turn it off. It goes at most once an hour per ticket, so it can't loop with an auto-responder. It isn't marketing, so opt-outs and quiet hours never stop it. The medical director and legal confirm the wording before the first patient (`docs/launch-checklist.md`).
Why: a person in danger mustn't wait for a reply (PRD SUP-03). Platform wording means every brand gives the same safe answer.
Decided by: stand-in, to confirm with Vahid. The wording is to be confirmed by the medical director and legal.

### SUP5. First-response targets run on the wall clock

Decision: an urgent ticket is due a first response within an hour, a clinical-queue ticket within four hours and a support-queue ticket within a day, counted on the wall clock, so a weekend never pauses an urgent ticket. These are the platform's maximums: when tenant settings arrive, a tenant may shorten one, never lengthen it. The automatic safety reply never counts as a first response; in the urgent and clinical queues only a person's reply counts, and in the support queue an agent's does too. Every five minutes a job marks tickets past due once, with an audit entry and a `ticket.overdue` event carrying ids, the queue and the due time only.
Why: the PRD sets targets for clinical safety, so a tenant can make them stricter but not weaker. An automatic reply that counted would stop the clock without anyone having read the message.
Decided by: stand-in, to confirm with Vahid.

### SUP6. Possible complaints and adverse events wait for a person, and go to governance's registers once those exist

Decision: triage marks a ticket "possible complaint" or "possible adverse event", and staff or an agent can add either by hand. A possible adverse event sends the ticket to the clinical queue. A person can dismiss a "possible" flag, with an audit entry; only the clinical team dismisses a clinical one. Setting a flag only ever escalates a ticket. Confirming a complaint or an adverse event comes with clinical governance's registers: a person confirms it with a summary, it goes to governance (`recordComplaint`, or `reportIncident` with `support:clinical`), the ticket keeps a flag that can't be cleared here, and a mistaken one is closed in the register. A complaint can then be raised on a ticket with no matched patient. Flag events carry ids and the category only, never the person's words.
Why: governance owns the registers and their deadlines (PRD GOV-02, GOV-03); the helpdesk is one way in, and keeps no register of its own. A word list can only suspect a complaint; a person decides. Until the registers exist, the possible flag keeps the ticket away from agents and in front of staff.
Decided by: stand-in, to confirm with Vahid.

### SUP7. What each channel brings in

Decision: email, SMS and chat arrive as messages on a ticket; a reply goes back on the channel and to the address the person last wrote from. Chat is the patient app's Messages (SUP13). A phone call is logged by the staff member who took it, as a written summary: no recording, no transcript. Attachments aren't stored in v1; the message shows how many were sent (CRM4). An SMS that only says STOP opens no ticket. Email arrives once the email provider is chosen (CRM3).
Why: one inbox across channels (PRD SUP-01). A recording or transcript of a call is clinical evidence with its own consent and retention rules, so it waits for its own ruling.
Decided by: stand-in, to confirm with Vahid.

### SUP8. Identity before detail

Decision: an inbound email or SMS is matched to a patient only when exactly one patient has that address; when two share it, nothing is linked and staff link by hand. Until a staff member confirms who they are talking to (by date of birth or by calling back on the number on file, audited per ticket with who, when and how), the patient panel shows only what they check against (SUP9). A patient signed in to the patient app is confirmed already. A patient app ticket's patient can't be changed. Replies go only to the address the person wrote from.
Why: anyone can type an email address, so "staff must not discuss" would be training, not a rule (PRD SUP-03, ADR 0009). Guessing between two patients who share a family email would show one person's details to another.
Decided by: stand-in, to confirm with Vahid.

### SUP9. What the patient panel shows support

Decision: with `patients:read`, the panel shows the matched patient's name and date of birth; once identity is confirmed it adds their email and mobile. It never shows anything from the chart: intake answers, notes, scripts, doses or conditions. Order, billing and shipment details join the panel as those modules expose them to support.
Why: support needs enough to check identity and answer service questions (PRD SUP-03), and nothing that would make a support request a clinical record read.
Decided by: stand-in, to confirm with Vahid.

### SUP10. Macros are approved before anyone can send them

Decision: a holder of `support:manage` writes, approves and archives macros, and may approve their own. Changing an approved macro's wording sends it back to draft. A reply can use only an approved macro. A macro holds no patient details.
Why: the constraint is that frontline staff can't send saved wording nobody approved (PRD SUP-04). Two people for one-to-one service replies would be machinery, and a tenant with one manager could never have a macro.
Decided by: stand-in, to confirm with Vahid.

### SUP11. The helpdesk's permissions and their zones

Decision: `support:read`, `support:reply`, `support:manage` and `messaging:manage` are operational; `support:clinical` is clinical, so it works for a clinical role or under break-glass (ADM3). The support role gets `support:read` and `support:reply`. Admin gets those two plus `support:manage` and `messaging:manage`, so it can give and take the support role (ADM4), but never `support:clinical`. The medical director, prescribers and clinicians get `support:read`, `support:reply` and `support:clinical`. Finance gets nothing of the helpdesk, because ticket messages are free text. The owner holds every key, and needs break-glass for `support:clinical`. Unknown or missing permissions fail closed.
Why: the PRD limits finance to health data as amounts and codes, and keeps the clinical queue for the clinical team (SUP-02). `support:read` opens text but not the patient record: the panel needs `patients:read` as well.
Decided by: stand-in, to confirm with Vahid.

### SUP12. What an agent may do on a ticket

Decision: an agent can read and reply in the support queue only. The API refuses an agent's reply in the clinical queue or on a ticket flagged emergency, self-harm, possible adverse event, possible complaint, legal or a request for a person; the safety reply is the only automatic message on those. An agent can escalate (send to the clinical queue, make urgent, add a warning flag) but never lower, clear a flag, assign, link a patient, confirm identity or log a call. `support:clinical`, `support:manage` and `messaging:manage` are forbidden to agents whatever their role. An agent's actions are audited as the agent, and its replies are marked automatic. Triage runs before an agent sees a message. When agents are off, everything is in the human queues already.
Why: a prompt is not enforcement (ADR 0012). A person can always reach a human (PRD AIP-08), and anything that may be clinical, a complaint or legal needs a person's judgement.
Decided by: stand-in, to confirm with Vahid.

### SUP13. Ticket text lives in the clinical zone, and the patient app reads the same store

Decision: a ticket is metadata only, in the operational zone. Every subject, body and comment is in the clinical zone (`clinical.messages`, `clinical.ticket_comments`). The patient app's Messages is the same tickets and messages seen from the patient's side: a patient sees the conversations they started in the app, their own messages and the replies (as "you", "team" or "automatic"), and never a comment, flag, queue, logged call or which staff member wrote. A care-team conversation goes to the clinical queue and stays there.
Why: people write health details into any request, so the text is clinical in effect (ADR 0007, 0008). One message store means a second one can't drift from it (ADR 0027).
Decided by: stand-in, to confirm with Vahid.
