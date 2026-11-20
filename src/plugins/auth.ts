import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { findSignedInUser, type SignInMembership } from '../db/session.js';
import type { TenantContext } from '../db/tenant.js';
import type { Role } from '../db/schema/values.js';
import { clerkJwksUrl, parseAuthorizedParties, resolveClerkIssuer } from '../lib/clerk.js';
import { BadRequestError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../lib/errors.js';
import { permissionsOf, type Permission } from '../lib/permissions.js';
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
 * needs a permission needs a tenant, and the person's role there must hold it.
 */
export const TENANT_HEADER = 'x-medora-tenant';

export interface TenantAccess {
  tenantId: string;
  membershipId: string;
  role: Role;
  permissions: ReadonlySet<Permission>;
}

export interface Auth {
  userId: string;
  email: string;
  memberships: SignInMembership[];
  /** The tenant this request acts in, when it named one. */
  tenant: TenantAccess | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

/** Failed sign-ins per address: enough for a person's typos and retries, not for guessing. */
export const FAILED_SIGN_IN_LIMIT: Limit = { name: 'failed-sign-in', max: 30, windowSeconds: 300 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Identity {
  clerkUserId: string;
  /** Only when the sign-in provider says it is verified. */
  email: string | null;
}

async function verifyDevToken(token: string): Promise<Identity> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.DEV_JWT_SECRET ?? ''), { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedError();
  return { clerkUserId: payload.sub, email: typeof payload['email'] === 'string' ? payload['email'] : null };
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
  return { clerkUserId: payload.sub, email };
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
  if (!membership || membership.status !== 'active') throw new ForbiddenError("You aren't a member of that tenant", 'not_a_member');
  return { tenantId: membership.tenantId, membershipId: membership.membershipId, role: membership.role, permissions: permissionsOf(membership.role) };
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const access: Access | undefined = request.routeOptions.config?.access;
    if (access === undefined || access === 'public') return;

    const identity = await identify(request);
    const user = await findSignedInUser(identity, request.id);
    if (!user) {
      throw new UnauthorizedError("This sign-in has no Medora account. Ask an owner to invite you.", 'no_account');
    }
    const tenant = tenantAccess(request, user.memberships);
    request.auth = { userId: user.userId, email: user.email, memberships: user.memberships, tenant };

    if (access === 'signed-in') return;
    if (!tenant) throw new BadRequestError(`Choose a tenant first (${TENANT_HEADER})`, 'tenant_required');
    if (!tenant.permissions.has(access.permission)) throw new ForbiddenError();
  });
});

/** The tenant a route that declared a permission is acting in. */
export function requireTenant(request: FastifyRequest): { auth: Auth; tenant: TenantAccess } {
  const auth = request.auth;
  if (!auth?.tenant) throw new BadRequestError(`Choose a tenant first (${TENANT_HEADER})`, 'tenant_required');
  return { auth, tenant: auth.tenant };
}

/** The tenant scope for withTenant: the tenant this request acts in, and the person acting. */
export function tenantContextOf(request: FastifyRequest): TenantContext {
  const { auth, tenant } = requireTenant(request);
  return { tenantId: tenant.tenantId, actor: { type: 'person', userId: auth.userId }, requestId: request.id };
}
