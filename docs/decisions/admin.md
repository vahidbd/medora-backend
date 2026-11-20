# Admin and staff access

Rulings for staff access, roles, invitations, two-step sign-in, sign-in history and break-glass (PRD ADM-03, ADM-06, ADM-07; ADRs 0011, 0012, 0030 and 0036 set the rules). Tenant settings, brands and onboarding rulings follow in this file as they land.

Rulings marked "Decided by: stand-in" were made while the product owner was away, by the model the product owner named to stand in, and are to be confirmed with them.

### ADM1. Starting roles live in code; tenants add custom roles

Decision: every tenant has the starting roles in `ROLES` (`src/db/schema/values.ts`), with their permissions in `ROLE_PERMISSIONS` (`src/lib/permissions.ts`). Tenants can't edit them, so a permission a module adds reaches every tenant at once. A tenant makes a custom role by copying a starting role and editing its name, description and permissions; it is a row in `platform.roles` and a snapshot that never gains permissions on its own. A membership on one has `role = 'custom'` and `custom_role_id` set, checked by the database (a foreign key on `(tenant_id, custom_role_id)` and a check that the two go together). Code checks permissions, never role keys.
Why: the PRD asks for default roles plus tenant-made ones. Keeping the starting roles in code means no tenant's copy of "owner" drifts behind, and keeping `role` a text key leaves every other module's code working.
Decided by: stand-in (Fable 5.2), to confirm with Vahid. Replaces: FND3's "a constant for now".

### ADM2. The starting roles

Decision: `owner` (every permission, computed from `PERMISSIONS`), `admin` (the PRD's tenant admin: staff, roles and settings; no clinical permission), `medical_director`, `prescriber` (doctors and nurse practitioners), `clinician` (nurses, dietitians, psychologists, coaches: sees patients, no prescribing), `support`, `finance`, `operations`, `marketing` and `compliance`. There is no separate nurse role and no pharmacist role: a profession is a credential, not a set of permissions, and Medora does not dispense (ADR 0013). A test holds `admin`, `finance`, `support`, `operations`, `marketing` and `compliance` to no clinical-zone permission.
Why: a role is what someone may do in Medora. Nurses and allied health differ by scope of practice, which the credentials module checks per person.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### ADM3. Clinical permissions need a clinical role, or break-glass

Decision: every permission names the data zone it opens (`PERMISSION_ZONES`). A clinical-zone permission works only for a clinical role (`prescriber`, `clinician`, `medical_director`, or a custom role copied from one). Anyone else whose role holds one, the owner included, must open break-glass first: a reason of 10 to 500 characters, 60 minutes, an audit entry and an event, and a line in a review list for whoever holds `break_glass:review` (the medical director). It can be ended early; nobody reviews their own. The auth plugin applies the rule, so every module's routes inherit it, and a refused request answers `break_glass_required`. The reason stays in its row and never goes in the audit details, because people sometimes name a patient in it.
Why: the PRD says the owner sees "no clinical notes by default", ADR 0030 says someone always holds every permission, and PRD ADM-03 asks for break-glass that is logged and reviewed. One rule meets all three.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### ADM4. Only people change access, and only within what they hold

Decision: inviting, changing a membership and making, editing or deleting a role need `staff:manage` or `roles:manage` (owner and admin). The routes declare no agent tool, the services refuse any actor that isn't a person (`person_only`), and `AGENT_FORBIDDEN_PERMISSIONS` lists the keys no agent role may ever hold. Granting follows ADR 0030: you give or take away only a role whose permissions you all hold, so the tenant admin can invite every role except the clinical ones and the owner. Editing a role is granting: both its old and new permissions must be ones you hold, and you can't edit the role you hold. Role changes write an audit entry with the permission keys before and after, and a `role.changed` event.
Why: PRD ADM-07 says only tenant admins change roles and AI never changes permissions; the granting rule closes the "edit my own role" route around it.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### ADM5. Invitations

Decision: `POST /v1/staff/invitations` takes an email, an optional display name, a role and an optional end date. The person's account is found or made by email through `platform.invite_person`, which keeps a display name only for a new account, and an `invited` membership is added (or an open invitation is renewed). The reply is the same whether or not the email already had a Medora account. The email goes out after commit through Clerk's invitation API (`src/modules/staff/invitations.ts`, ADR 0029), landing on the console's `/sign-up`; a failure leaves the invitation saved and the screen offers Resend. Medora itself decides whether an invitation still works: it becomes an active membership on the person's next sign-in within 14 days of being sent (`platform.accept_invitations`), and after that only Resend brings it back. An invitation nobody accepted can be withdrawn, which deletes its membership (a row-level policy lets only invited rows be deleted). A tenant can send 60 invitations an hour.
Why: Medora decides access and Clerk only delivers the email (ADR 0011), so a withdrawn or stale invitation must be dead on our side, not only in Clerk's link.
Decided by: stand-in (Fable 5.2), to confirm with Vahid. The email is sent from the request after commit rather than from the outbox, because no outbox worker exists yet; it moves there when one does.

### ADM6. Every staff session needs a second factor, and sign-ins are kept

Decision: every route that acts in a tenant refuses a session whose token doesn't show a verified second factor (Clerk's `fva` claim, second value 0 or more) with 403 `two_step_required`. There is no per-role setting and no off switch. `GET /v1/me` answers without one, with `secondFactor: false`, so the console can ask the person to set it up. A passkey counts only as the first factor. Each new sign-in session writes one row to `platform.sign_ins`: when, the trusted client address, a short device description (never the raw header) and whether a second factor was used, keyed by a hash of Clerk's session id. A person reads their own (`GET /v1/me/sign-ins`); an admin reads a staff member's (`GET /v1/staff/:membershipId/sign-ins`), through a policy that shows a person's sign-ins to the tenants they belong to.
Why: the PRD's non-functional rule is MFA for all staff, and every staff role sees personal details. A setting that can only weaken the rule is machinery nobody needs; "required by role" (PRD ADM-06) is met by every role requiring it.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### ADM7. Time-limited access is an end date on the membership

Decision: a membership may have `expires_at`. From that instant the API treats it like a paused membership. It is set and cleared through `PATCH /v1/staff/:membershipId` and on an invitation, with an audit entry and a `membership.expiry_changed` event. Time-limited access for Medora's own platform team uses the same field.
Why: the PRD's platform team sees no patient data "unless the tenant grants time-limited access"; an end date on an ordinary membership is the smallest thing that does it, and it suits contractors too.
Decided by: stand-in (Fable 5.2), to confirm with Vahid.

### ADM8. Requests that act in a tenant without a permission of their own

Decision: a route may declare `access: 'member'`: signed in, a member of the tenant it names, with a second factor, and no permission of its own. Opening and closing break-glass use it, because whether break-glass is allowed depends on the role's clinical permissions, not on a key.
Why: `'signed-in'` alone would skip the tenant and the second factor, and inventing a permission for "may open break-glass" would duplicate what the role already says.
