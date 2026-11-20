# Webhooks

Rulings for the one webhook inbox (ADR 0029: incoming webhooks are verified, stored, then processed once per provider event id). `src/lib/webhooks.ts` and `platform.webhook_inbox`.

### WHK1. Every provider's webhooks go through one inbox

Decision: a provider's public route checks the signature, then calls `receiveWebhook`, which stores the delivery in `platform.webhook_inbox` and processes it in a second transaction with the handler its module registered through `onWebhook(provider, kind, handler)`. The handler's work and the row's "processed" mark commit together. A delivery the provider sends again (same tenant, provider and provider event id) is stored once and processed once. The route answers 2xx whether processing worked or not, because a failed delivery is retried from the inbox, not by the provider.
Why: ADR 0027 asks for one engine per job, and at least four modules (prescribing, billing, CRM, consults) receive webhooks. A second inbox would be a second set of rules about retries and duplicates.

### WHK2. A delivery nobody handles yet waits untouched

Decision: a delivery whose kind has no handler registered stays `received`, with no attempt counted. It is processed when the module that handles it ships, by the retry sweep.
Why: modules ship one at a time; a delivery that arrives before its handler is not a failure.

### WHK3. Failed deliveries are retried, and record only an error code

Decision: a handler that throws rolls back its work; the row becomes `failed`, its attempts go up by one and `last_error` holds the error's code (an AppError code, `postgres_<sqlstate>`, or the error's class name), never its message. `processPendingWebhooks(tenantId)` retries `received` and `failed` rows under 8 attempts, oldest first; the job runner calls it. A row at 8 attempts waits for a person.
Why: a message can quote the body, and the body can hold a patient's number or text (ADR 0026). Eight tries over the runner's backoff covers a provider's or our own outage without retrying a broken delivery forever.

### WHK4. The tenant is in the address the provider calls

Decision: each tenant's webhook address carries its tenant id (`/v1/webhooks/<provider>/:tenantId/...`), and the delivery is stored and processed inside that tenant with the system as the actor. A tenant that doesn't exist answers 403 with the same body as a wrong signature.
Why: the inbox is a tenant table like any other (ADR 0006), and the tenant must be known before anything is stored. The same answer for both refusals means the address can't be used to find tenant ids (FND1).

### WHK5. The API never deletes a delivery or rewrites its body

Decision: `medora_app` may insert deliveries and update only their status, attempts, error and processed time. How long bodies are kept is a later ruling, written before the first patient.
Why: the inbox is the record of what a provider told us, which a disputed script or payment needs.
