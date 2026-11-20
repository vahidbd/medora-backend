import { z } from 'zod';
import type { ParchmentOrganization } from '../../../config/parchment.js';
import { ParchmentFailure, type ParchmentClient, type ParchmentPatientDetails, type ParchmentUser } from './types.js';

/**
 * The live Parchment client: one tenant's organisation, through Medora's
 * partner credentials. Tokens are cached in memory for less than their hour,
 * which is safe to miss (ADR 0029), and a rejected token is replaced once.
 * Nothing from a request or reply body is ever logged or put in an error.
 */
export interface LiveSettings {
  apiUrl: string;
  partnerId: string;
  partnerSecret: string;
}

const PATIENT_SCOPES = ['create:patient', 'update:patient'];
const USER_SCOPES = ['read:user'];
const TIMEOUT_MS = 10_000;
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

const tokens = new Map<string, { token: string; expiresAt: number }>();

const envelope = z.object({ success: z.boolean(), data: z.unknown().optional(), error: z.object({ validation: z.array(z.object({ field: z.string() })).optional() }).optional() });

/** Parchment's patient body (its create and update calls take the same fields). */
export function patientBody(details: ParchmentPatientDetails): Record<string, unknown> {
  return {
    partner_patient_id: details.partnerPatientId,
    partner_id: 'standalone',
    given_name: details.givenName,
    family_name: details.familyName,
    date_of_birth: details.dateOfBirth,
    sex: details.sex,
    email: details.email,
    ...(details.mobile ? { mobile_phone: details.mobile } : {}),
    ...(details.address
      ? {
          australian_street_address: {
            street_number: details.address.streetNumber,
            street_name: details.address.streetName,
            suburb: details.address.suburb,
            state: details.address.state,
            postcode: details.address.postcode,
          },
        }
      : {}),
    ...(details.medicare
      ? {
          medicare_card_number: details.medicare.number,
          ...(details.medicare.irn ? { medicare_irn: details.medicare.irn } : {}),
          ...(details.medicare.validTo ? { medicare_valid_to: details.medicare.validTo } : {}),
        }
      : {}),
  };
}

export function liveParchment(settings: LiveSettings, org: ParchmentOrganization): ParchmentClient {
  const base = `${settings.apiUrl.replace(/\/$/, '')}/v1/organizations/${encodeURIComponent(org.organizationId)}`;
  const patients = `${base}/users/${encodeURIComponent(org.userId)}/patients`;

  async function token(scopes: string[]): Promise<string> {
    const key = `${org.organizationId}:${org.userId}:${scopes.join(',')}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const reply = await fetch(`${settings.apiUrl.replace(/\/$/, '')}/v1/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-partner-id': settings.partnerId,
        'x-partner-secret': settings.partnerSecret,
        'x-organization-id': org.organizationId,
        'x-organization-secret': org.organizationSecret,
        'x-user-id': org.userId,
      },
      body: JSON.stringify({ grantType: 'client_credentials', scope: scopes }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await reply.json().catch(() => null)) as { data?: { accessToken?: unknown } } | null;
    const value = body?.data?.accessToken;
    if (!reply.ok || typeof value !== 'string') throw new ParchmentFailure(reply.ok ? 502 : reply.status);
    tokens.set(key, { token: value, expiresAt: Date.now() + TOKEN_LIFETIME_MS });
    return value;
  }

  async function call(scopes: string[], method: string, url: string, body?: unknown): Promise<unknown> {
    const send = async (bearer: string) =>
      fetch(url, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'x-organization-secret': org.organizationSecret, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let reply = await send(await token(scopes));
    if (reply.status === 401) {
      tokens.delete(`${org.organizationId}:${org.userId}:${scopes.join(',')}`);
      reply = await send(await token(scopes));
    }
    if (reply.status === 404) return null;
    const parsed = envelope.safeParse(await reply.json().catch(() => null));
    if (!reply.ok || !parsed.success || !parsed.data.success) {
      const fields = parsed.success ? (parsed.data.error?.validation ?? []).map((v) => v.field) : [];
      throw new ParchmentFailure(reply.ok ? 502 : reply.status, fields);
    }
    return parsed.data.data ?? null;
  }

  return {
    async createPatient(details) {
      const data = (await call(PATIENT_SCOPES, 'POST', patients, patientBody(details))) as { parchment_patient_id?: unknown } | null;
      if (typeof data?.parchment_patient_id !== 'string') throw new ParchmentFailure(502);
      return { parchmentPatientId: data.parchment_patient_id };
    },

    async updatePatient(parchmentPatientId, details) {
      const data = await call(PATIENT_SCOPES, 'PUT', `${patients}/${encodeURIComponent(parchmentPatientId)}`, patientBody(details));
      if (data === null) throw new ParchmentFailure(404);
    },

    async listUsers() {
      const data = (await call(USER_SCOPES, 'GET', `${base}/users`)) as unknown;
      const list = Array.isArray(data) ? data : ((data as { users?: unknown[] } | null)?.users ?? []);
      return list.flatMap((user): ParchmentUser[] => {
        const u = user as { user_id?: unknown; email?: unknown };
        return typeof u.user_id === 'string' ? [{ parchmentUserId: u.user_id, email: typeof u.email === 'string' ? u.email.toLowerCase() : null }] : [];
      });
    },
  };
}
