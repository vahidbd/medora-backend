# Foundation

Rulings for the platform foundation (ADRs 0006, 0008, 0011, 0024 to 0030 set the rules; these record the choices made while building it).

### FND1. A signed-in person picks a tenant with a header

Decision: a staff request names its tenant in the `x-medora-tenant` header (the tenant's id). Every route that needs a permission requires it, even for a person with one tenant, and answers 400 `tenant_required` without it. `GET /v1/me` needs no tenant and lists the person's tenants, so the web app can pick one. A tenant the person has no active membership in answers 403 `not_a_member`, the same as one that doesn't exist, so the answer can't be used to find tenant ids.
Why: one person may work for more than one tenant; the tenant must be explicit, never guessed from what the person happens to belong to today, and guessing an id must not reveal anything.

### FND2. A first sign-in claims an invited account by verified email only

Decision: a Clerk identity is matched to a Medora user by its stored link first, then by email, but only when Clerk marks the email verified and the user row has no link yet. The match writes the link, through `platform.claim_user`, so the next sign-in matches by link.
Why: staff are invited before they ever sign in; an unverified email is not proof of ownership.

### FND3. Roles and their permissions are a constant until roles can be edited

Decision: the four starting roles (`owner`, `clinician`, `support`, `finance`) and their permission keys live in `src/lib/permissions.ts`. Only `owner` holds `staff:manage`. Editing roles is a later feature and must follow ADR 0030's granting rules, which are already enforced by `assertCanGrant`.
Why: a role editor is not needed to start, and a constant is easy to review.

### FND4. `/health` answers with the release commit

Decision: `GET /health` answers `{ status, service, version }`, where `version` is the commit the release was built from (`RELEASE_SHA`, written into the image by CI). Outside a deployed service it is `development`.
Why: the deploy check (ADR 0024) must be able to tell the new release from the old one.

### FND5. The API sends no CORS headers

Decision: no CORS plugin is registered. Browsers call the web app's server, never the API.
Why: ADR 0030; an API that browsers can't call directly has one less way in.

### FND6. Membership changes keep a tenant governable

Decision: `PATCH /v1/staff/:membershipId` changes a staff member's role or status. Nobody changes their own membership (`own_membership`). A person grants only a role whose permissions they hold themselves (ADR 0030). A change that would leave the tenant with no active owner is refused (`last_owner`). The service locks the tenant's active owner rows first, then the target row, then reads the acting person's membership again, so two owners demoting each other at the same moment can't both succeed. Every change writes an audit entry and a `membership.role_changed` or `membership.status_changed` event in the same transaction. No agent tool does this.
Why: a tenant with no owner can't be managed by anyone but us, and a race between two owners is exactly when that would happen. Who may do what is a person's decision (ADR 0012).

### FND7. Every route declares access, reply, audit, events and agent tool

Decision: each route's `config` names its `access` (`public`, `signed-in` or a permission) and its schema names a success reply. A route that changes data also names its audit actions, its events and its agent tool, or `{ none: reason }` for each. `src/plugins/route-rules.ts` refuses to register a route that leaves one out, so the app doesn't start.
Why: "Hit every surface" is easy to forget on a new route; a check at start-up can't be forgotten (ADRs 0008, 0012, 0014, 0016, 0030).

### FND8. Failed sign-ins are limited per address

Decision: 30 failed sign-ins from one client address in 5 minutes answer 429 with `Retry-After` until the window passes. The counters live in `platform.rate_limit_counters`, so every API instance shares them. The address is the one `src/lib/client-ip.ts` trusts: a signed `x-medora-client-ip` from the web app's server, else the host's edge header, else the socket.
Why: ADR 0030 asks for limits on sign-in from the first route; counting in Postgres needs no new service, and an address a caller can simply claim can't be the key.
