import { createHash, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * How Medora names video rooms and the people in them (ADR 0120,
 * docs/decisions/consults.md CNS7). Medora sets both when it issues a join
 * token, so a verified callback names the tenant, the consult and the person
 * without a lookup. Ids only: never a name.
 */

const uuid = z.uuid();

export function consultRoomName(tenantId: string, consultId: string): string {
  return `consult:${tenantId}:${consultId}`;
}

export function roomOf(name: string | undefined): { tenantId: string; consultId: string } | null {
  const [prefix, tenantId, consultId, ...rest] = (name ?? '').split(':');
  if (prefix !== 'consult' || rest.length > 0 || !uuid.safeParse(tenantId).success || !uuid.safeParse(consultId).success) return null;
  return { tenantId: tenantId!, consultId: consultId! };
}

export type Participant = { party: 'patient'; patientId: string } | { party: 'clinician'; userId: string };

export function participantIdentity(participant: Participant): string {
  return participant.party === 'patient' ? `patient:${participant.patientId}` : `clinician:${participant.userId}`;
}

export function participantOf(identity: string | undefined): Participant | null {
  const [party, id, ...rest] = (identity ?? '').split(':');
  if (rest.length > 0 || !uuid.safeParse(id).success) return null;
  if (party === 'patient') return { party, patientId: id! };
  if (party === 'clinician') return { party, userId: id! };
  return null;
}

/**
 * The video server signs each webhook with a short-lived token (HS256, our
 * API secret, issued by our API key) whose `sha256` claim is the body's hash.
 * Compared in constant time (ADR 0030).
 */
export async function videoWebhookVerified(body: string, authorization: string | undefined, key: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!key || !secret || !authorization) return false;
  try {
    const token = authorization.replace(/^Bearer\s+/i, '');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { issuer: key, algorithms: ['HS256'], requiredClaims: ['exp'] });
    if (typeof payload.sha256 !== 'string') return false;
    const claimed = Buffer.from(payload.sha256, 'base64');
    const actual = createHash('sha256').update(body, 'utf8').digest();
    return claimed.length === actual.length && timingSafeEqual(claimed, actual);
  } catch {
    return false;
  }
}

/** The fields of a video server callback that consult evidence uses. Times are whole seconds. */
export const videoCallback = z.object({
  event: z.string(),
  id: z.string().min(1),
  createdAt: z.coerce.number().int().positive(),
  room: z.object({ name: z.string() }).optional(),
  participant: z.object({ identity: z.string() }).optional(),
});

/** The callbacks that become evidence; the rest are answered and dropped. */
export const VIDEO_EVIDENCE_KINDS = ['participant_joined', 'participant_left', 'participant_connection_aborted', 'room_finished'] as const;
export type VideoEvidenceKind = (typeof VIDEO_EVIDENCE_KINDS)[number];
