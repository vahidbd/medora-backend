# Medora backend

Medora is a multi-tenant telehealth operating platform for Australia. Tenants (clinics and operators) run their whole care operation on it: brand sites, intake, consults, prescribing through Parchment, orders, billing, support, CRM and AI agents. This repo is the API and its workers: TypeScript, Fastify, Zod, Drizzle and Postgres. The web app is `medora-front`.

## What we never compromise on

These come from the PRD's design principles. If a rule here fights the task you were given, stop and ask the person who gave it to you.

1. **Compliance is enforced by the system.** No script without a recorded real-time consult, no medicine charged without a current script, blocked products stay blocked. These live in the backend and the database, never only in a screen, and no route, agent tool or test helper skips them (ADR 0009).
2. **Clinical and marketing data are kept apart.** Four schemas: `clinical`, `operational`, `marketing`, `platform`. Marketing code never reads clinical data (ADR 0007).
3. **Every patient touch is logged.** Reads and writes of clinical data write an audit entry in the same transaction (ADR 0008).
4. **One core, many brands.** Conditions, protocols, brands and prices are tenant data, never code (ADR 0023).
5. **Tenants are isolated by the database.** Every tenant table has `tenant_id` and a row-level security policy; the API's role owns nothing (ADR 0006).
6. **Patient data stays in Australia** (ADR 0005).

## A note from the product owner

This is the biggest platform we will run, and it holds people's health. I want simple systems that make the right behaviour unsurprising: the smallest model that fits the real constraint, no machinery because it looks impressive, nothing kept just because it exists. Build the core properly before building wide. When you are unsure, ask; a question costs minutes, a wrong guess in clinical or money code costs far more.

## Words

Read [GLOSSARY.md](GLOSSARY.md) before naming anything. One word per thing, the same in tables, API fields, code and screens. "You" is the coding agent; "agent" is one of Medora's own AI agents.

## The ways to hurt yourself

1. **Patient data where it doesn't belong.** Never put patient details (names, contact details, dates of birth, Medicare numbers, intake answers, notes) in logs, error reports, events, test fixtures, commit messages, pull request text or a model prompt without masking. Fixtures use made-up people.
2. **A query without a tenant.** Feature code reaches the database only through `withTenant` (`src/db/tenant.ts`). Never import the pool or `db` from `src/db/client.ts` in a module; lint and the dependency rules refuse it.
3. **Production in development.** Never put a production connection string, deploy token or key in a shell, `.env`, test or cloud coding session. The app refuses a remote database outside a deployed service (`src/config/database-guard.ts`); don't work around it.
4. **Skipping a gate "for now".** No `if (process.env.NODE_ENV === 'test')` around a compliance gate, permission check or audit write. Tests set up the state the gate needs.
5. **Editing history.** Never edit a migration that has merged, an accepted ADR, an audit entry or a ledger line. Add a new one.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, say in the pull request which of these applied:

- **Tenant and brand**: tenant id and policy on new tables; brand-specific copy comes from configuration.
- **Role and permission**: the route checks a permission; record-attached data checks the record's permission (ADR 0030).
- **Data zone**: the right schema; nothing clinical reachable from marketing.
- **Audit**: every write, and every read of clinical data, writes an audit entry.
- **Contract**: request and response schemas; the frontend regenerates its types (ADR 0014).
- **Events**: the events the change emits, or why none (ADR 0016).
- **Agent tools**: the tools an agent gets for this, with the role limits, or why none (ADR 0012).
- **Money**: postings lock first and go to the ledger; outside calls carry an idempotency key and happen after commit (ADRs 0016, 0029).
- **Time**: whose time zone "today" is in (ADR 0017).
- **The way back out**: pause needs resume, cancel needs reinstate, a flag needs its off state tested.
- **Docs**: a ruling in `docs/decisions/`, and an ADR if the change is system-level (ADR 0001).

## Running it

```bash
npm ci
cp .env.example .env
npm run db:setup        # once: creates the local roles and databases (local Postgres 16 on 127.0.0.1:5432)
npm run db:migrate      # apply migrations as the owner role
npm run db:seed         # a made-up tenant with two staff members
npm run dev             # API on http://localhost:4000, the OpenAPI document at /openapi.json
npm run dev:token -- owner@example.test   # a signed-in token for local requests
```

Development uses `AUTH_MODE=dev` and a local database only. Send the token as `Authorization: Bearer <token>` and the tenant's id as `x-medora-tenant` (`GET /v1/me` lists your tenants). Seed data is synthetic: made-up tenants, brands and patients. Never copy production data into development, not even de-identified.

## Verifying

```bash
npm run typecheck
npm run lint
npm test -- test/integration/tenancy.test.ts   # one file while you iterate
npm run check           # every repo check CI runs that isn't a test: boundaries, names, file names, migrations, skills, ADR copies, contract, schema drift
```

- Tests run against a real Postgres (`TEST_DATABASE_URL`, default `postgres://postgres:postgres@127.0.0.1:5432/medora_test`). Each worker gets its own copy of the migrated database.
- Test behaviour that can break: permission and tenancy guards, compliance gates, money, migrations, parsing outside formats, race fixes, and whatever a bug fix changed. Skip tests for what types already guarantee.
- A bug fix starts with a failing test at the lowest layer that shows it.
- Every new table gets a tenancy test: another tenant can't read, change or delete its rows.
- No sleeps, retries or wall-clock assertions in tests. A test that needs a timeout to pass is wrong.
- Tests must assert (`requireAssertions` is on).
- Run single files while you iterate. CI runs the full suite.

## Pull requests

- One feature or one fix per pull request, under about 1,500 changed lines (ADR 0034).
- Use the template in `.github/pull_request_template.md`. Name the ADRs and rulings the change follows, fill in "Merge danger", and list the surfaces from "Hit every surface".
- Changes to clinical rules, money, permissions, tenancy, data zones, AI autonomy or migrations need the product owner's review (`.github/CODEOWNERS`).
- Never weaken a check to get CI green: no skipped tests, no lint suppressions, no baseline files.

## Documentation

- `docs/adr/`: system-level decisions, the same files in `medora-front`. Read the ones in the area you touch before you start. Write one in the same pull request when your change is system-level (`write-adr` skill).
- `docs/decisions/<feature>.md`: why a feature works the way it does. New rulings go in the same pull request as the code.
- `docs/providers.md`: every outside service, its region and what data reaches it.
- `docs/launch-checklist.md`: what must be true before the first patient.
- Never commit plans, scratch notes or session transcripts.

## Where code lives

```
src/
├── app.ts                 # builds the Fastify app: plugins, health routes, modules
├── index.ts, start.ts     # serve; migrate then serve
├── worker.ts              # the worker service: scheduled jobs and outbox delivery (docs/decisions/jobs.md)
├── config/                # env (with the boot checks), database guard, release commit
├── db/
│   ├── client.ts          # the pool: only db/ and lib/ may import it
│   ├── tenant.ts          # withTenant: the only way feature code reaches the database
│   ├── session.ts         # finds the signed-in person and their memberships
│   ├── health.ts          # readiness ping and the boot check on the database role
│   ├── schema/            # Drizzle tables, and values.ts (allowed values)
│   └── migrations/        # SQL migrations and the drizzle journal
├── lib/                   # feature-free helpers: errors, audit, events, field encryption, jobs, leases, outbox delivery, permissions, rate limit, client ip, redaction, time
├── plugins/               # auth, client ip, error handler, request log, route rules, security headers
└── modules/
    ├── index.ts           # registers every module under /v1
    ├── workers.ts         # every module's jobs and outbox handlers, for the worker
    └── <area>/            # one folder per business area; index.ts is its front door (ADR 0027)
contract/openapi.json      # the API contract, generated by `npm run contract` (ADR 0014)
scripts/                   # repo checks, build, release, local setup
```

- A module's `index.ts` exports what other code may use. Import another module only through its `index.ts`.
- Routes are thin: parse, check permission, call the service, map to the reply schema. Rules live in services.
- Keep files under 400 lines.

### Every route says what it does

A route declares these in its `config`, and the app refuses to start when one is missing (`src/plugins/route-rules.ts`):

- `access`: `'public'`, `'signed-in'`, or `{ permission: '<key>' }`. The auth plugin enforces it before the handler runs.
- A response schema for its success reply. Replies are checked against it: in tests a field the schema doesn't name fails the test; elsewhere it is cut off.
- For a route that changes data: `audit` (the audit actions it writes), `events` (the events it emits) and `agentTool` (the tool an agent uses to do the same). When there is none, write `{ none: '<why>' }`.

After changing a route or schema, run `npm run contract` and commit `contract/openapi.json`.

## Skills

Skills live in `.agents/skills/` and are mirrored to `.claude/skills/` (CI checks the copies match). Grill before building (`grill-with-docs`), test first (`tdd`), diagnose before fixing (`diagnosing-bugs`), review before opening a pull request (`review-change`), and record decisions with `write-adr`.
