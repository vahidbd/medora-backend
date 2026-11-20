import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { findSignedInUser, type SignInIdentity, type SignInMembership } from '../db/session.js';
import type { TenantContext } from '../db/tenant.js';
import type { MembershipRole } from '../db/schema/values.js';
import { type AgentClaims, verifyAgentCredential } from '../lib/agent-credential.js';
import { clerkJwksUrl, parseAuthorizedParties, resolveClerkIssuer } from '../lib/clerk.js';
import { describeDevice } from '../lib/device.js';
import { BadRequestError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../lib/errors.js';
import { AGENT_FORBIDDEN_PERMISSIONS, heldPermissions, isClinicalRole, usablePermissions, type Permission, type RoleGrant } from '../lib/permissions.js';
import { blockedFor, countAttempt, type Limit } from '../lib/rate-limit.js';
import type { Access } from './route-rules.js';

/**
 * Sign-in and permissions (ADRs 0011, 0030). Clerk proves who someone is;
 * Medora decides what they may do.
 *
 * Every route declares its access (src/plugins/route-rules.ts). For any
 * route that isn't public, the bearer token is verified (a Clerk session
 * token, or with AUTH_MODE=dev one signed with DEV_JWT_SECRET), matched to a
 * Medora account (FND2), and the tenant named by the `x-medora-tenant`
 * header is checked against the person's memberships (FND1). A route that
 * needs a permission needs a tenant, and the person's role there must hold it
 * and be able to use it (clinical permissions need a clinical role or
 * break-glass, ADM3), and the session must have verified a second factor
 * (ADM6).
 *
 * An agent calls a route in-process with `Authorization: Agent <credential>`
 * (docs/decisions/agents.md AGT2). It may call only routes that need a
 * permission, in the tenant its credential names, holding that permission.
 */
export const TENANT_HEADER = 'x-medora-tenant';

export interface TenantAccess {
  tenantId: string;
  membershipId: string;
  role: MembershipRole;
  customRoleId: string | null;
  /** What this request may use now. */
  permissions: ReadonlySet<Permission>;
  /** Everything the role holds, usable or not: what granting is measured against (ADR 0030). */
  held: ReadonlySet<Permission>;
  clinicalRole: boolean;
  breakGlassUntil: Date | null;
}

export interface Auth {
  userId: string;
  email: string;
  displayName: string | null;
  /** Whether this session verified a second factor (ADM6). */
  secondFactor: boolean;
  memberships: SignInMembership[];
  /** The tenant this request acts in, when it named one. */
  tenant: TenantAccess | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
    /** Set instead of `auth` when one of Medora's agents is calling. */
    agent: AgentClaims | null;
  }
}

/** Failed sign-ins per address: enough for a person's typos and retries, not for guessing. */
export const FAILED_SIGN_IN_LIMIT: Limit = { name: 'failed-sign-in', max: 30, windowSeconds: 300 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Identity = SignInIdentity;

/**
 * Clerk's `fva` claim: minutes since the first and second factor were
 * verified, -1 for one never verified in this session (ADM6).
 */
export function secondFactorVerified(fva: unknown): boolean {
  return Array.isArray(fva) && typeof fva[1] === 'number' && fva[1] >= 0;
}

const sessionIdOf = (payload: Record<string, unknown>): string | null =>
  typeof payload['sid'] === 'string' && payload['sid'] ? payload['sid'] : null;

async function verifyDevToken(token: string): Promise<Identity> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.DEV_JWT_SECRET ?? ''), { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedError();
  return {
    clerkUserId: payload.sub,
    email: typeof payload['email'] === 'string' ? payload['email'] : null,
    sessionId: sessionIdOf(payload),
    secondFactor: secondFactorVerified(payload['fva']),
  };
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyClerkToken(token: string): Promise<Identity> {
  const issuer = resolveClerkIssuer(env);
  if (!issuer) throw new UnauthorizedError();
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(clerkJwksUrl(issuer));
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['RS256'] });
  // `azp` is the origin the session was made on, inside the signed token: a
  // token minted for another site on the same Clerk instance is refused.
  const parties = parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES);
  const azp = typeof payload['azp'] === 'string' ? payload['azp'].replace(/\/$/, '') : null;
  if (parties.length > 0 && (!azp || !parties.includes(azp))) throw new UnauthorizedError();
  if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedError();
  // Clerk's session token carries these only when the session token template
  // adds them (README, "Clerk"). An address not marked verified proves nothing.
  const email = payload['email_verified'] === true && typeof payload['email'] === 'string' ? payload['email'] : null;
  return { clerkUserId: payload.sub, email, sessionId: sessionIdOf(payload), secondFactor: secondFactorVerified(payload['fva']) };
}

async function identify(request: FastifyRequest): Promise<Identity> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
  const retryAfter = await blockedFor(FAILED_SIGN_IN_LIMIT, request.clientIp);
  if (retryAfter !== null) throw new TooManyRequestsError(retryAfter);
  try {
    const token = header.slice('Bearer '.length);
    return env.AUTH_MODE === 'clerk' ? await verifyClerkToken(token) : await verifyDevToken(token);
  } catch {
    await countAttempt(FAILED_SIGN_IN_LIMIT, request.clientIp);
    throw new UnauthorizedError('Your sign-in has expired or is not valid. Sign in again.');
  }
}

function tenantAccess(request: FastifyRequest, memberships: SignInMembership[]): TenantAccess | null {
  const raw = request.headers[TENANT_HEADER];
  if (raw === undefined) return null;
  const tenantId = Array.isArray(raw) ? raw[0] : raw;
  if (!tenantId || !UUID.test(tenantId)) throw new BadRequestError(`${TENANT_HEADER} must be a tenant id`);
  const membership = memberships.find((m) => m.tenantId === tenantId.toLowerCase());
  if (!membership || !isUsable(membership)) throw new ForbiddenError("You aren't a member of that tenant", 'not_a_member');
  const grant = grantOf(membership);
  const breakGlassOpen = membership.breakGlassUntil !== null && membership.breakGlassUntil.getTime() > Date.now();
  return {
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    role: membership.role,
    customRoleId: membership.customRole?.id ?? null,
    permissions: usablePermissions(grant, breakGlassOpen),
    held: heldPermissions(grant),
    clinicalRole: isClinicalRole(grant),
    breakGlassUntil: breakGlassOpen ? membership.breakGlassUntil : null,
  };
}

/** Active, and not past the end of time-limited access (ADM7). */
export function isUsable(membership: Pick<SignInMembership, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  return membership.status === 'active' && (membership.expiresAt === null || membership.expiresAt.getTime() > now);
}

export function grantOf(membership: Pick<SignInMembership, 'role' | 'customRole'>): RoleGrant {
  return { role: membership.role, customPermissions: membership.customRole?.permissions ?? null, customClinical: membership.customRole?.clinical ?? null };
}

function namedTenant(request: FastifyRequest): string | undefined {
  const raw = request.headers[TENANT_HEADER];
  return (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
}

async function authenticateAgent(request: FastifyRequest, access: Exclude<Access, 'public'>, token: string): Promise<void> {
  if (typeof access === 'string') throw new ForbiddenError('Agents may call only routes that need a permission', 'agent_route');
  let claims: AgentClaims;
  try {
    claims = await verifyAgentCredential(token);
  } catch {
    throw new UnauthorizedError('The agent credential is not valid');
  }
  if (namedTenant(request) !== claims.tenantId) throw new ForbiddenError("The agent credential is for another tenant", 'not_a_member');
  if (!claims.permissions.includes(access.permission) || AGENT_FORBIDDEN_PERMISSIONS.has(access.permission)) throw new ForbiddenError();
  request.agent = claims;
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', null);
  app.decorateRequest('agent', null);

  app.addHook('onRequest', async (request) => {
    const access: Access | undefined = request.routeOptions.config?.access;
    if (access === undefined || access === 'public') return;

    const header = request.headers.authorization;
    if (header?.startsWith('Agent ')) return authenticateAgent(request, access, header.slice('Agent '.length));

    const identity = await identify(request);
    const user = await findSignedInUser(identity, {
      requestId: request.id,
      clientIp: request.clientIp,
      device: describeDevice(request.headers['user-agent']),
    });
    if (!user) {
      throw new UnauthorizedError("This sign-in has no Medora account. Ask an owner to invite you.", 'no_account');
    }
    const tenant = tenantAccess(request, user.memberships);
    request.auth = {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      secondFactor: identity.secondFactor,
      memberships: user.memberships,
      tenant,
    };

    if (access === 'signed-in') return;
    if (!tenant) throw new BadRequestError(`Choose a tenant first (${TENANT_HEADER})`, 'tenant_required');
    // docs/decisions/admin.md ADM6: every staff role needs a second factor; there is no setting that turns it off.
    if (!identity.secondFactor) {
      throw new ForbiddenError('Set up two-step sign-in to carry on. Every staff account needs it.', 'two_step_required');
    }
    if (access === 'member') return;
    if (!tenant.permissions.has(access.permission)) {
      if (tenant.held.has(access.permission)) {
        throw new ForbiddenError('This needs clinical access. Open break-glass first, with your reason.', 'break_glass_required');
      }
      throw new ForbiddenError();
    }
  });
});

/** The tenant a route that declared a permission is acting in, for a person. Agents get tenantContextOf only. */
export function requireTenant(request: FastifyRequest): { auth: Auth; tenant: TenantAccess } {
  if (request.agent) throw new ForbiddenError('Only a person may do this', 'person_only');
  const auth = request.auth;
  if (!auth?.tenant) throw new BadRequestError(`Choose a tenant first (${TENANT_HEADER})`, 'tenant_required');
  return { auth, tenant: auth.tenant };
}

/** The tenant scope for withTenant: the tenant this request acts in, and the person or agent acting. */
export function tenantContextOf(request: FastifyRequest): TenantContext {
  const agent = request.agent;
  if (agent) {
    return {
      tenantId: agent.tenantId,
      actor: { type: 'agent', agentId: agent.agentId, runId: agent.runId, approvedBy: agent.approvedBy },
      requestId: request.id,
    };
  }
  const { auth, tenant } = requireTenant(request);
  return { tenantId: tenant.tenantId, actor: { type: 'person', userId: auth.userId }, requestId: request.id };
}
