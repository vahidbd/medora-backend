import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env.js';
import { findPatientSignIn } from '../db/patient-session.js';
import type { TenantContext } from '../db/tenant.js';
import { clerkJwksUrl, parseAuthorizedParties, resolveClerkIssuer } from '../lib/clerk.js';
import { BadRequestError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../lib/errors.js';
import { blockedFor, countAttempt, type Limit } from '../lib/rate-limit.js';

/**
 * Patient sign-in (ADR 0100, docs/decisions/patients.md IDN2 to IDN4).
 * Patients sign in on their own Clerk instance; a patient route accepts only
 * that instance's tokens (in AUTH_MODE=dev, tokens with `aud: "patient"`), and
 * the staff routes refuse them. The request names its tenant with
 * `x-medora-tenant`, set by the patient app's server (IDN4).
 *
 * - `patient-sign-in`: a verified patient token in a tenant. The patient
 *   record may not exist yet, and the session may not have confirmed the
 *   date of birth. Only account creation and the date-of-birth check use it.
 * - `patient`: the record exists and this session has confirmed the date of
 *   birth (IDN-07). Everything else a patient does uses it.
 */
export const PATIENT_AUDIENCE = 'patient';
export const PATIENT_TENANT_HEADER = 'x-medora-tenant';

export interface PatientAuth {
  tenantId: string;
  clerkUserId: string;
  /** The sign-in session (`sid`), which confirms the date of birth once (IDN3). */
  sessionId: string;
  /** Only when the sign-in provider says it is verified. */
  email: string | null;
  phone: string | null;
  patientId: string | null;
  confirmed: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    patient: PatientAuth | null;
  }
}

/** Failed patient sign-ins per address, counted apart from staff so one can't lock out the other. */
export const FAILED_PATIENT_SIGN_IN_LIMIT: Limit = { name: 'failed-patient-sign-in', max: 30, windowSeconds: 300 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PatientIdentity {
  clerkUserId: string;
  sessionId: string;
  email: string | null;
  phone: string | null;
}

function hasAudience(payload: JWTPayload, audience: string): boolean {
  return Array.isArray(payload.aud) ? payload.aud.includes(audience) : payload.aud === audience;
}

/** A staff token must never be a patient token (ADR 0100). Used by the staff sign-in check. */
export function isPatientToken(payload: JWTPayload): boolean {
  return hasAudience(payload, PATIENT_AUDIENCE);
}

function identityFrom(payload: JWTPayload, verifiedOnly: boolean): PatientIdentity {
  if (typeof payload.sub !== 'string' || !payload.sub) throw new UnauthorizedError();
  if (typeof payload['sid'] !== 'string' || !payload['sid']) throw new UnauthorizedError();
  const email = typeof payload['email'] === 'string' && (!verifiedOnly || payload['email_verified'] === true) ? payload['email'].toLowerCase() : null;
  const phone =
    typeof payload['phone_number'] === 'string' && (!verifiedOnly || payload['phone_number_verified'] === true) ? payload['phone_number'] : null;
  return { clerkUserId: payload.sub, sessionId: payload['sid'], email, phone };
}

async function verifyDevPatientToken(token: string): Promise<PatientIdentity> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.DEV_JWT_SECRET ?? ''), {
    algorithms: ['HS256'],
    audience: PATIENT_AUDIENCE,
  });
  return identityFrom(payload, false);
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyClerkPatientToken(token: string): Promise<PatientIdentity> {
  const issuer = resolveClerkIssuer({ CLERK_ISSUER: env.CLERK_PATIENT_ISSUER, CLERK_PUBLISHABLE_KEY: env.CLERK_PATIENT_PUBLISHABLE_KEY });
  if (!issuer) throw new UnauthorizedError();
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(clerkJwksUrl(issuer));
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['RS256'] });
  const parties = parseAuthorizedParties(env.CLERK_PATIENT_AUTHORIZED_PARTIES);
  const azp = typeof payload['azp'] === 'string' ? payload['azp'].replace(/\/$/, '') : null;
  if (parties.length > 0 && (!azp || !parties.includes(azp))) throw new UnauthorizedError();
  return identityFrom(payload, true);
}

async function identifyPatient(request: FastifyRequest): Promise<PatientIdentity> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
  const retryAfter = await blockedFor(FAILED_PATIENT_SIGN_IN_LIMIT, request.clientIp);
  if (retryAfter !== null) throw new TooManyRequestsError(retryAfter);
  try {
    const token = header.slice('Bearer '.length);
    return env.AUTH_MODE === 'clerk' ? await verifyClerkPatientToken(token) : await verifyDevPatientToken(token);
  } catch {
    await countAttempt(FAILED_PATIENT_SIGN_IN_LIMIT, request.clientIp);
    throw new UnauthorizedError('Your sign-in has expired or is not valid. Sign in again.');
  }
}

function patientTenant(request: FastifyRequest): string {
  const raw = request.headers[PATIENT_TENANT_HEADER];
  const tenantId = Array.isArray(raw) ? raw[0] : raw;
  if (!tenantId || !UUID.test(tenantId)) throw new BadRequestError(`${PATIENT_TENANT_HEADER} must be a tenant id`, 'tenant_required');
  return tenantId.toLowerCase();
}

export async function authenticatePatient(request: FastifyRequest, access: 'patient' | 'patient-sign-in'): Promise<void> {
  const identity = await identifyPatient(request);
  const tenantId = patientTenant(request);
  const state = await findPatientSignIn(tenantId, identity, request.id);
  if (!state.tenantFound) throw new ForbiddenError("This service isn't available here", 'tenant_unavailable');
  request.patient = { tenantId, ...identity, patientId: state.patientId, confirmed: state.confirmed };
  if (access === 'patient-sign-in') return;
  if (!state.patientId) throw new ForbiddenError('Create your account first', 'no_patient_record');
  if (!state.confirmed) throw new ForbiddenError('Confirm your date of birth to carry on', 'date_of_birth_needed');
}

/** The signed-in patient of a route with `patient` access. */
export function requirePatient(request: FastifyRequest): PatientAuth & { patientId: string } {
  const patient = request.patient;
  if (!patient?.patientId) throw new ForbiddenError('Create your account first', 'no_patient_record');
  return { ...patient, patientId: patient.patientId };
}

/** The tenant scope for withTenant: the patient's tenant, with the patient acting on their own record. */
export function patientContextOf(request: FastifyRequest): TenantContext {
  const patient = requirePatient(request);
  return { tenantId: patient.tenantId, actor: { type: 'patient', patientId: patient.patientId }, requestId: request.id };
}

/** For `patient-sign-in` routes before the record exists: the tenant, with the system acting for the new patient. */
export function signInContextOf(request: FastifyRequest): TenantContext {
  const patient = request.patient;
  if (!patient) throw new UnauthorizedError();
  const actor = patient.patientId ? ({ type: 'patient', patientId: patient.patientId } as const) : ({ type: 'system' } as const);
  return { tenantId: patient.tenantId, actor, requestId: request.id };
}
