# Field encryption

Rulings for sealing sensitive fields with each tenant's own key. ADR 0010 sets the rule; these record how `src/lib/field-crypto.ts` does it.

### ENC1. A sealed value is bound to its tenant, its column and its key

Decision: `encryptField(tx, purpose, plain)` seals with AES-256-GCM under the tenant's data key, and the authenticated data is the format, the tenant id, the purpose (`<schema>.<table>.<column>`) and the key id. The stored text is `enc1.<key id>.<iv>.<ciphertext>.<tag>`. `decryptField` with any other tenant, purpose or key fails with `FieldCryptoError`, never with the wrong value.
Why: a database dump, a misdirected query or a bad copy between rows must not turn one patient's Medicare number into another column's value, or one tenant's value into another's.

### ENC2. Each tenant's data key is made on first use and kept for ever

Decision: a tenant's data key is 32 random bytes, made the first time anything is sealed in that tenant, and stored only sealed by the key provider in `platform.tenant_keys` (one row per tenant for now, unique on `tenant_id`). Two first uses at once both try to insert; the unique index keeps one, and the other reads it back. Making a key writes a `tenant_key.created` audit entry. No role may change or remove a key row: a trigger refuses UPDATE, DELETE and TRUNCATE for everyone, the owner included. Opened keys are cached in the API process, filled only after the row was read inside that tenant's transaction.
Why: lazy creation means tenant onboarding has nothing extra to call; a lost or edited key would make every value sealed with it unreadable, so keys are append-only like the audit log. Rotation is a later ruling that adds rows.

### ENC3. Production needs a KMS key provider; the local provider is for development and staging

Decision: `FIELD_KEY_PROVIDER=local` seals data keys with `FIELD_ENCRYPTION_KEY` (base64 of 32 random bytes), checked at boot in every environment. Staging and production refuse the example key from `.env.example`. Production refuses the local provider altogether, so production does not start until the AWS KMS provider (ADR 0010, Sydney) is added with its own `KEY_PROVIDERS` value and migration. That is a line in `docs/launch-checklist.md`.
Why: ADR 0010 says data keys are wrapped by a key held in KMS. A key in an environment variable is fine for made-up data and not enough for patients, and a boot refusal can't be forgotten (ADR 0025).

### ENC4. Opening a value is covered by the caller's read audit

Decision: `decryptField` writes no audit entry. The module that reads the record (a patient, an intake, a note) writes the read audit entry for it, once per record, in the same transaction (ADR 0008).
Why: one audit entry per record read says who saw what; one per field would bury it.
