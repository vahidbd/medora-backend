# Messaging

Rulings for the email and SMS rails and, later, lifecycle messaging (PRD section 14). ADRs 0005 (data in Australia), 0008 (audit), 0027 (one owner per thing), 0028 (records are never edited) and 0029 (outside calls after commit) set the rules; these record the choices made while building them. `src/modules/messaging/`.

Rulings marked "Decided by: stand-in" were settled by the product owner's stand-in while the product owner was away, and are listed in the pull request to confirm.

### CRM1. One rail for every email and SMS

Decision: every email and SMS Medora sends is written by `queueMessage` in the messaging module, with its kind: `support` (a ticket reply) or `transactional` (a message the person needs because of something they did, such as an order update). Marketing gets its own kind when lifecycle messaging arrives. Inbound messages, chat lines and logged calls will be written by the same module, so the helpdesk and the patient app read one store. Transactional and support messages skip marketing consent, sending limits and quiet hours, so they carry no promotional content.
Why: one place to send means one place for the provider, the region and the at-most-once rule (ADR 0027). A message with promotional content is marketing under the Spam Act whatever we call it.
Decided by: stand-in, to confirm with Vahid.

### CRM2. Sent after commit, at most once, and moved on only by the provider

Decision: `queueMessage` writes the message as `queued` and emits `message.queued` in the change's own transaction. The delivery handler then claims it (`queued` to `sending`) in its own transaction, calls the provider, and records `sent` with the provider's id, or `failed` with the provider's code only. A handler that runs again finds the row claimed and sends nothing. A row still `sending` 15 minutes after it was claimed (the process died mid-call) becomes `failed` with `unconfirmed`, for a person to check before sending again; nothing resends on its own. Twilio's status webhooks move a message forward only (`sent`, `delivered`, `failed`), so a late `sent` never undoes `delivered`, and an undelivered SMS records `twilio_<code>`. A status webhook for a message we have no record of yet stays in the webhook inbox to try again (WHK). A caller can pass an idempotency key; the same key returns the first message.
Why: a send from inside a transaction that rolls back can't be taken back, and neither Twilio nor most email providers dedupe for us (ADR 0029). A person deciding whether to resend an unconfirmed message is safer than a patient getting a clinical message twice.
Decided by: stand-in, to confirm with Vahid.

### CRM3. Email goes through one interface, and the provider isn't chosen yet

Decision: email is sent through `EmailSender`. `EMAIL=fake` keeps what would have been sent in memory (development, tests, staging); `EMAIL=none` turns email off and refuses to queue one. Production refuses the fake. Every email carries our own `Message-ID` (`<message id@sender's domain>`), so a reply's `In-Reply-To` finds its message and ticket, and an automatic email carries `Auto-Submitted: auto-replied`, so an auto-responder doesn't answer it.
Why: email carries patient text, so the provider must store and process it in Australia (ADR 0005) and needs a row in `docs/providers.md` and an ADR. That choice is the product owner's, so the interface and the fake come first.
Decided by: stand-in, to confirm with Vahid. The provider is Vahid's choice.

### CRM4. A message is a record

Decision: a message's text, addresses and author are never changed or deleted once written; the database refuses it. Only its delivery status, the provider's id and the failure code change. A correction is a new message or a comment. Attachments aren't stored in v1: the message keeps how many were sent, so staff can ask the person to upload through the patient app.
Why: what we told a patient, and what they told us, is part of their record (ADR 0028). A photo sent by SMS is often clinical and needs its own ruling before we keep it.
Decided by: stand-in, to confirm with Vahid.

### CRM5. Each brand has its own addresses, and marketing never shares one with service

Decision: a sender is a brand's address on a channel for a purpose: `service` (ticket replies and transactional messages) or `marketing`. One per brand, channel and purpose. An admin (`messaging:manage`) sets them; phone numbers are stored in E.164 and email addresses lower-cased. A brand from another tenant is not found. Agents can't change them.
Why: a patient sees the brand they signed up with, never the platform (PRD 14). Marketing SMS must come from another number, or a STOP sent to a marketing message at the carrier would also block dose reminders and the safety reply.
Decided by: stand-in, to confirm with Vahid.
