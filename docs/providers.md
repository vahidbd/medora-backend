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
| Twilio | Phone consults, SMS | Australian region (AU1) | Phone numbers, call metadata, message text | Message text may mention care; templates keep it out | Planned |
| Error tracking (self-hosted, Sentry-compatible) | Errors from the API and web app | Sydney | Scrubbed errors (ADR 0026) | No | Planned |
| GitHub | Code, CI | US | Code only. No patient data, keys or production data | No | In use |
