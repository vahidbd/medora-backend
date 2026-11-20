# medora-backend

The Medora API and its workers. Medora is a multi-tenant telehealth operating platform for Australia; the web app is `medora-front`.

Working on the code (you or a coding agent): start with [AGENTS.md](AGENTS.md). System decisions are in [docs/adr/](docs/adr/README.md), feature rulings in [docs/decisions/](docs/decisions/README.md), outside services in [docs/providers.md](docs/providers.md).

## Local development

Needs Node 22 and Postgres 16 on `127.0.0.1:5432`.

```bash
npm ci
cp .env.example .env
npm run db:setup && npm run db:migrate && npm run db:seed
npm run dev
```

The app refuses a database that isn't local unless it runs as a deployed service, so a production connection string in `.env` fails at start.

## Setting up a deployed environment

Staging and production refuse to start until every setting below is safe (ADR 0025). The error lists what is missing.

### Database

Postgres in an Australian region. Two logins:

- **The owner** (`DATABASE_MIGRATION_URL`): owns the tables and runs migrations. The first migration creates the `medora_app` and `medora_marketing` group roles, so the owner needs `CREATEROLE` for that first run.
- **The API** (`DATABASE_URL`): a login that is a member of `medora_app` and owns nothing:

  ```sql
  CREATE ROLE medora_api LOGIN PASSWORD '<generated>' IN ROLE medora_app;
  ```

  At start the API checks its role and refuses to serve as a superuser, a role that bypasses row-level security, or a role that owns (or belongs to the owner of) any table.

The start command applies pending migrations as the owner, then serves as the API role.

### Sign-in (Clerk)

- `AUTH_MODE=clerk`, `CLERK_PUBLISHABLE_KEY` (a `pk_live_` key in production), `CLERK_AUTHORIZED_PARTIES` (the web app's origins, comma-separated).
- In Clerk, customise the session token to carry the person's email and whether it is verified:

  ```json
  { "email": "{{user.primary_email_address}}", "email_verified": "{{user.email_verified}}" }
  ```

  A first sign-in links to an invited account only through a verified email (docs/decisions/foundation.md, FND2).
- In Clerk, under Multi-factor, switch on Authenticator application and Backup codes. Every staff request needs a verified second factor (Clerk's `fva` claim, which session tokens carry by default), and there is no setting that turns this off (docs/decisions/admin.md ADM6).
- `CLERK_SECRET_KEY` (an `sk_live_` key in production) and `CONSOLE_URL` (the staff console's https origin): invitations are emailed through Clerk and land on `<CONSOLE_URL>/sign-up` (ADM5). Restrict sign-ups in Clerk so only invited people can make a sign-in.

### Everything else

- `MEDORA_ENV`: `staging` or `production`.
- `FORWARDED_IP_SECRET`: at least 32 random characters, the same value in the web app.
- `STORAGE_MODE=s3` with `S3_BUCKET`, `S3_REGION` (`ap-southeast-2` or `ap-southeast-4`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_ENDPOINT` when not AWS.
- `SENTRY_DSN`: an error tracker that keeps data in Australia (ADR 0026). Optional; unset turns error tracking off.

### AI agents

Agents run in their own service from the same image (`railway.agents.json`, start command `node dist/agents.js`), never in the API (docs/decisions/agents.md AGT8). Give it the same database and environment as the API, plus:

- `AGENTS_ENABLED=true` to let tenants switch agents on. Anything else keeps every agent off (the platform kill switch, AGT5).
- `AGENT_MODEL_CLIENT=bedrock` and `AGENT_BEDROCK_REGION` (`ap-southeast-2` or `ap-southeast-4`). AWS credentials come from the service's standard AWS variables or role, allowed to invoke only the Claude models the agents pin (`src/modules/agents/definitions.ts`). Leave Bedrock's model invocation logging off.

An agent runs only with a passing eval result for its current version in `evals/results/`. Record results against staging, never production:

```bash
AGENT_MODEL_CLIENT=bedrock npm run evals -- --record          # every agent
AGENT_MODEL_CLIENT=bedrock npm run evals -- --agent support    # one agent, without recording
```

## Deploys

Deploys are off until the repository variable `DEPLOYS` is `on`. With it on, a green CI run on `main` deploys staging; production is deployed by hand (Actions, "Deploy", with the commit already live on staging). Each deploy waits until `/health` reports the new commit, watches it, and rolls back if it fails (ADR 0024).

GitHub settings the workflows read:

| Name | Kind | Used for |
|---|---|---|
| `DEPLOYS` | variable | `on` turns deploys on |
| `RAILWAY_TOKEN` | secret, per environment | deploying to the host |
| `RAILWAY_SERVICE` | variable, per environment | the service to deploy |
| `API_URL` | variable, per environment | where the deploy check reads `/health` |
| `STAGING_API_URL`, `PRODUCTION_API_URL` | variables | the production gate and the live-version check |
| `SIBLING_REPO_TOKEN` | secret | read-only access to `medora-front`, so CI can check the ADRs and glossary match |
