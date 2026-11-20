# Support

Rulings for the helpdesk (PRD section 13): tickets, triage, the clinical queue, replies, macros, the patient app's Messages and each brand's help centre. ADRs 0007 (data zones), 0008 (audit), 0009 (compliance in the system), 0012 (agents), 0027 (one owner per thing) and 0028 (records are never edited) set the rules; these record the choices made while building them. `src/modules/support/` and `src/modules/help-centre/`. Sending email and SMS is in `messaging.md` (CRM).

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

Decision: an agent can read and reply in the support queue only. The API refuses an agent's reply in the clinical queue or on a ticket flagged emergency, self-harm, possible adverse event, possible complaint, legal or a request for a person; the safety reply is the only automatic message on those. An agent can escalate (send to the clinical queue, make urgent, add a warning flag) but never lower, clear a flag, assign, link a patient, confirm identity or log a call. `support:clinical`, `support:manage` and `messaging:manage` are forbidden to agents whatever their role. An agent's actions are audited as the agent, and its replies are marked automatic. An agent's reply reaches the helpdesk as the agents' own event (`agent_message.created`, `docs/decisions/agents.md` AGT16) and is sent through the same reply service and checks as a person's, so there is one reply path; its tools are `update_ticket` and `flag_ticket`. Triage runs before an agent sees a message. When agents are off, everything is in the human queues already.
Why: a prompt is not enforcement (ADR 0012). A person can always reach a human (PRD AIP-08), and anything that may be clinical, a complaint or legal needs a person's judgement.
Decided by: stand-in, to confirm with Vahid.

### SUP13. Ticket text lives in the clinical zone, and the patient app reads the same store

Decision: a ticket is metadata only, in the operational zone. Every subject, body and comment is in the clinical zone (`clinical.messages`, `clinical.ticket_comments`). The patient app's Messages is the same tickets and messages seen from the patient's side: a patient sees the conversations they started in the app, their own messages and the replies (as "you", "team" or "automatic"), and never a comment, flag, queue, logged call or which staff member wrote. A care-team conversation goes to the clinical queue and stays there.
Why: people write health details into any request, so the text is clinical in effect (ADR 0007, 0008). One message store means a second one can't drift from it (ADR 0027).
Decided by: stand-in, to confirm with Vahid.

### SUP14. Each brand has its own help centre, and it is the knowledge base

Decision: a help centre **article** belongs to exactly one brand, in the operational zone. The help centre is the knowledge base the PRD asks for (SUP-04, SUP-06): there are no staff-only articles until someone asks for them, since macros already hold staff wording. Copying an article to another brand is a later convenience on the screen.
Why: brands can differ in price and policy, and may be deliberately kept apart, so a shared article would carry one brand's wording into another. The wording holds no patient details, and support agents read it, which marketing data shouldn't be (ADR 0007).
Decided by: stand-in, to confirm with Vahid.

### SUP15. Article wording is versioned, and approved wording is never changed

Decision: an article's title, summary and body live on versions. An article has at most one open draft, and each save replaces it with a new version, so the approval call names the version its approver read and is refused if the draft has changed since. Approving the draft publishes it in place of the live version in the same transaction, and the live version stays up while the next draft waits. An approved version is never changed or removed, and only an approved version can be live: database triggers refuse both, whatever code asks. Unpublishing takes the article off the public pages and away from agents; publishing puts the last approved wording back up. Discarding the draft of an article that was never published removes the article, since nothing of it was ever public. There is no separate archive state: an unpublished article is it.
Why: the approved versions, each with its writer and approver, are the archive of every public asset that TGA advertising enforcement needs (PRD risk register). An archive state on top of unpublished would be a second way to say the same thing.
Decided by: stand-in, to confirm with Vahid; dropping the archive state was the builder's simplification.

### SUP16. Who approves, and the checks before anything goes public

Decision: a `support:manage` holder writes and approves articles and may approve their own, as with macros (SUP10); the version stores both its writer and its approver, and approval has its own audit entry beside publishing. One publish check reads every public text: an article's title, summary, body and slug on approval and again when it is put back up, and a section's name whenever it is set. On approval the checks it passed are stored on the version (`checked_with`, from `HELP_CENTRE_CHECKS`); an approved version can't change, so when it goes back up they go in the audit entry. Today (`format-1`) it refuses raw HTML, images, and links that are not https or the brand's own pages; the same rules refuse such wording when a draft is saved. Its next rule refuses a prescription-only product named in the tenant's catalogue, once the products module exists, and no brand's help centre goes live before then (launch checklist). When the marketing compliance module arrives it re-checks live versions and flags failures to `support:manage`; nothing is taken down without a person. A term list in code is never used.
Why: a tenant with one manager must be able to publish a P0 feature, and a colleague's click is not the TGA control: the check and the archive are. The pages are indexable, so "no drug names in ads or pages" (PRD) applies to them. A list of medicine names in code would tie the platform to one tenant's treatments (ADR 0023). Images would need storage and a new origin in the web app's content security policy.
Decided by: stand-in, to confirm with Vahid. The product owner may prefer a second person to approve; that is the first thing to confirm.

### SUP17. The public pages, sections and slugs

Decision: the public help centre is read by the host the brand's site is served on, for a live or paused brand with a verified domain, without sign-in: the sections with their published articles, one article by its slug, and a search. An unknown host, or a brand without a verified domain, is a 404; a real brand with nothing published gets an empty list. Each brand has its own **sections** (a name and a position), changed by `support:manage` without approval and audited; a section with articles can't be removed. An article's `slug`, the last part of its public address, is unique in its brand and fixed once first published (the database refuses a change), so links and citations keep working; its section and position change without approval. Pages are cached for 60 seconds; a search is never cached. Each client IP is limited to 120 requests a minute. Search words are never stored or logged, and the reads write no audit entry because they hold no patient details. The pages carry no tracking and call no clinical endpoint.
Why: paused brands still have patients who need help. A free-text section name couldn't order the sections or be renamed in one place, and a fixed list would be code, not tenant data. People type health details into search boxes.
Decided by: stand-in, to confirm with Vahid.

### SUP18. Articles describe the service, never medicine

Decision: help centre articles cover the service: how consults work, orders and delivery, billing, the account and privacy. They give no medical advice (no dosing, side effects, suitability or comparisons of treatments). The approval call carries the approver's confirmation, "This article describes our service only. It gives no medical advice and names no medicine.", and the API stores those words on the version. There is no clinical approval path; clinical questions keep going to the clinical team through triage (SUP3).
Why: a confirmation the API stores is a record, where a tick box on a screen is not (ADR 0009). Medical content in public pages would be advertising and advice at once.
Decided by: stand-in, to confirm with Vahid.

### SUP19. Agents answer only from published articles

Decision: the support agent's tool `search_help_centre` searches the live versions of published articles with Postgres full-text search (English) and returns the five best from the tenant's live or paused brands, each with its article id, version id and brand, so an answer names the exact wording it used; each body is cut to 4,000 characters so five fit in one tool reply. No result is an empty list, and the agent hands off. It needs `help_centre:read`, which is operational, held by every staff role and allowed to agents, rather than giving agents `support:read`. That key reaches published articles only: drafts and taken-down articles are listed only for `support:manage` holders, which agents never are, so no route gives an agent unapproved wording. Conversations carry no brand yet, so the tool takes an optional brand; the agents thread pins it before any tenant with several brands switches agents on. AI voice uses the same tool.
Why: the PRD allows AI chat and voice to answer only from published articles (SUP-06). A narrow permission keeps the agent out of tickets. Full-text search in the database needs no new provider and no data leaves it.
Decided by: stand-in, to confirm with Vahid.
