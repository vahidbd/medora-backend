# Telephony

Rulings for phone and SMS through Twilio (ADRs 0005, 0020, 0029). `src/modules/telephony/`.

### TEL1. One Twilio client, in Twilio's Australian region, and no fake once deployed

Decision: every SMS and phone call goes through the telephony module's one client, on one Twilio account in its Australian region (`TWILIO_REGION=au1`, the Sydney edge), with an API key made in that region. `TELEPHONY=fake` keeps what it was asked to send in memory, for development and tests. Staging and production refuse to start with the fake or another region.
Why: support, CRM and consults all send through Twilio; one client means one set of keys and one place that knows the region (ADR 0027). A fake in production would silently drop patients' messages, and once phone consults arrive it could make up consult evidence.

### TEL2. Twilio's webhooks are signed, stored and handed to the module that owns them

Decision: Twilio calls `/v1/webhooks/twilio/:tenantId/<hook>`, where the hook is `sms-inbound`, `sms-status` or `voice-status`. The route checks `X-Twilio-Signature` against `PUBLIC_API_URL` plus the address Twilio called, then stores the delivery in the inbox (WHK1) as kind `sms.inbound` (event id: the message id), `sms.status` (message id and status) or `voice.status` (call id, status and sequence number). It answers with an empty TwiML reply. Support and CRM handle the SMS kinds; consults handle calls.
Why: Twilio signs the exact public address it called, which a proxy in front of the API changes, so the address comes from configuration. Each status is its own event, so "sent" then "delivered" are both kept.

### TEL3. Sending happens after commit, once per outbox row

Decision: `sendSms` is called by an outbox handler after the change that caused it has committed (ADR 0029), never inside a transaction. Twilio has no idempotency key for messages, so the caller records the provider's message id against its own row and never calls twice for one row.
Why: a message sent from inside a transaction that then rolls back can't be taken back.
