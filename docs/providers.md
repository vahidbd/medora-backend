# Providers

Every outside service Medora uses: where it runs and what data reaches it (ADR 0005). A new provider is added here in the same pull request that adds it. A provider that would receive health data outside Australia needs an ADR and the privacy impact assessment's approval first.

| Provider | Used for | Region | Data that reaches it | Health data? | Status |
| --- | --- | --- | --- | --- | --- |
| Railway | Hosting the API, workers and Postgres | Sydney (to confirm when the first environment is created) | Everything Medora stores | Yes | Planned |
| AWS (S3, KMS, Bedrock) | Files, encryption keys, AI models | ap-southeast-2 (Sydney) | Files, wrapped keys, prompts and replies | Yes | Planned |
| Clerk | Sign-in for staff and patients | US | Name, email, phone, sign-in methods | No | Planned |
| Parchment | Electronic prescribing | Australia | Patient identity, scripts | Yes | Planned |
| Stripe | Card payments | Card data held by Stripe; Stripe Australia | Payment details, amounts, customer email | No | Planned |
| eWAY | Card payments | Australia | Payment details, amounts | No | Planned |
| Twilio | Phone consults, SMS (one client, `src/modules/telephony/`) | Australian region (AU1, Sydney edge); which data Twilio keeps onshore in AU1 to confirm in the data processing agreement | Phone numbers, call times and lengths, message text, inbound SMS | Message text may mention care; templates keep it out. Inbound SMS can hold anything a patient writes | Planned |
| Error tracking (self-hosted, Sentry-compatible) | Errors from the API and web app | Sydney | Scrubbed errors (ADR 0026) | No | Planned |
| Identity gateway (a Document Verification Service broker, not chosen yet) | Checking a patient's identity document online (docs/decisions/patients.md IDN16) | Australia (a condition of choosing one) | Legal name, date of birth, document type and number | Identity only | Fake only; needs an ADR and a data processing agreement before it is switched on |
| HI Service (Services Australia) | Looking up a patient's IHI (IDN19) | Australia | Legal name, date of birth, sex, Medicare number | Yes | Fake only; needs a NASH certificate and conformance per tenant |
| GitHub | Code, CI | US | Code only. No patient data, keys or production data | No | In use |
