import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { App } from '../../src/app.js';
import type { ConsultMode, ConsultPurpose } from '../../src/db/schema/values.js';
import { consultRoomName, participantIdentity, type Participant } from '../../src/modules/consults/index.js';
import { addMember, admin, createUser } from './db.js';

/**
 * Patients, prescribers and consults for tests (docs/decisions/consults.md).
 * Made-up people only. Consult evidence is never inserted: a test plays the
 * video server, sending signed callbacks to the real webhook route, so the
 * signature check, the inbox and the handler all run as they do in production.
 * Build the app (testApp) before calling these.
 */

export async function createPatient(tenantId: string, options: { dateOfBirth?: string; mobile?: string } = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into clinical.patients (tenant_id, given_name, family_name, date_of_birth, sex) values ($1, 'Sam', 'Example', $2, 'not_stated') returning id`,
    [tenantId, options.dateOfBirth ?? '1988-03-14'],
  );
  const patientId = rows[0]!.id;
  if (options.mobile) {
    await admin.query(`insert into clinical.patient_contacts (tenant_id, patient_id, kind, value) values ($1, $2, 'mobile', $3)`, [tenantId, patientId, options.mobile]);
  }
  return patientId;
}

/** The consents care needs (privacy and telehealth terms), published by the tenant and given by the patient on the web. */
export async function giveCareConsents(tenantId: string, patientId: string): Promise<void> {
  for (const kind of ['privacy', 'telehealth_terms']) {
    await admin.query(
      `insert into clinical.consent_documents (tenant_id, kind, version, title, body) values ($1, $2, 1, 'Made-up terms', 'Made-up text.') on conflict do nothing`,
      [tenantId, kind],
    );
    await admin.query(
      `insert into clinical.patient_consents (tenant_id, patient_id, document_id, kind, decision, channel)
       select $1, $2, id, kind, 'given', 'web' from clinical.consent_documents where tenant_id = $1 and kind = $3 and version = 1`,
      [tenantId, patientId, kind],
    );
  }
}

/**
 * A clinician in standing: a membership, a clinician profile, and a
 * registration and indemnity someone else has checked. A medical practitioner
 * (the default) may also prescribe; a registered nurse may not.
 */
export async function createPrescriber(
  tenantId: string,
  options: { profession?: 'medical_practitioner' | 'registered_nurse'; timeZone?: string } = {},
): Promise<{ userId: string; email: string; clinicianId: string }> {
  const person = await createUser();
  const checker = await createUser();
  const membershipId = await addMember(tenantId, person.id, options.profession === 'registered_nurse' ? 'clinician' : 'prescriber');
  await addMember(tenantId, checker.id, 'medical_director');
  const { rows } = await admin.query<{ id: string }>(
    `insert into operational.clinicians (tenant_id, membership_id, profession, time_zone) values ($1, $2, $3, $4) returning id`,
    [tenantId, membershipId, options.profession ?? 'medical_practitioner', options.timeZone ?? 'Australia/Sydney'],
  );
  const clinicianId = rows[0]!.id;
  await admin.query(
    `insert into operational.clinician_credentials
       (tenant_id, clinician_id, kind, registering_body, registration_type, registration_status, reference, expires_on, verified_at, verified_by, created_by)
     values ($1, $2, 'registration', 'ahpra', 'general', 'practising', 'MED0000000001', '2099-09-30', now(), $3, $4)`,
    [tenantId, clinicianId, checker.id, person.id],
  );
  await admin.query(
    `insert into operational.clinician_credentials
       (tenant_id, clinician_id, kind, insurer, covers_telehealth_new_patients, expires_on, verified_at, verified_by, created_by)
     values ($1, $2, 'indemnity', 'Example Mutual', true, '2099-06-30', now(), $3, $4)`,
    [tenantId, clinicianId, checker.id, person.id],
  );
  return { userId: person.id, email: person.email, clinicianId };
}

/** Weekly hours: every day of the week, in the clinician's own zone, unless the days are given. */
export async function giveHours(tenantId: string, clinicianId: string, block: { startsAt: string; endsAt: string; slotMinutes?: number; weekdays?: number[] }): Promise<void> {
  for (const weekday of block.weekdays ?? [1, 2, 3, 4, 5, 6, 7]) {
    await admin.query(
      `insert into operational.clinician_hours (tenant_id, clinician_id, weekday, starts_at, ends_at, slot_minutes) values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, clinicianId, weekday, block.startsAt, block.endsAt, block.slotMinutes ?? 15],
    );
  }
}

/** Distinct slots for consults a test sets up directly, so they never collide in the overlap constraints. */
const SLOT_BASE = Math.floor((Date.now() - 300 * 86_400_000) / 60_000) * 60_000;
let nextSlot = 0;

/**
 * A scheduled consult written as fixture data, at a time of the test's
 * choosing (even the past, which booking refuses). Tests of booking itself
 * go through the routes.
 */
export async function bookConsult(
  tenantId: string,
  input: { patientId: string; clinicianUserId: string; mode?: ConsultMode; purpose?: ConsultPurpose; startsAt?: Date; minutes?: number },
): Promise<string> {
  const startsAt = input.startsAt ?? new Date(SLOT_BASE + nextSlot++ * 15 * 60_000);
  const endsAt = new Date(startsAt.getTime() + (input.minutes ?? 15) * 60_000);
  const { rows } = await admin.query<{ id: string }>(
    `insert into clinical.consults (tenant_id, patient_id, clinician_user_id, mode, purpose, scheduled_start, scheduled_end)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [tenantId, input.patientId, input.clinicianUserId, input.mode ?? 'video', input.purpose ?? 'initial', startsAt, endsAt],
  );
  return rows[0]!.id;
}

/**
 * Marks a fixture consult completed, as if it had run its scheduled time.
 * For tests of what follows a consult (who sees the patient next, reviews);
 * tests of how a consult completes play the video server instead.
 */
export async function completeConsult(consultId: string): Promise<void> {
  await admin.query("update clinical.consults set status = 'completed', started_at = scheduled_start, ended_at = scheduled_end where id = $1", [consultId]);
}

/** Signs a body the way the video server does: a short-lived HS256 token carrying the body's hash. */
export async function videoAuthorization(body: string, secret = process.env.VIDEO_API_SECRET ?? ''): Promise<string> {
  return new SignJWT({ sha256: createHash('sha256').update(body).digest('base64') })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(process.env.VIDEO_API_KEY ?? '')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

export async function postVideoWebhook(app: App, event: object, options: { authorization?: string; body?: string } = {}) {
  const body = options.body ?? JSON.stringify(event);
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/video',
    headers: { 'content-type': 'application/webhook+json', authorization: options.authorization ?? (await videoAuthorization(JSON.stringify(event))) },
    payload: body,
  });
}

export type VideoStep =
  | { kind: 'participant_joined' | 'participant_left' | 'participant_connection_aborted'; who: Participant; at: Date; id?: string }
  | { kind: 'room_finished'; at: Date; id?: string };

/** A video server event for a consult's room, in the server's own shape (whole seconds, as strings). */
export function videoEvent(tenantId: string, consultId: string, step: VideoStep): object {
  return {
    event: step.kind,
    id: step.id ?? `EV_${randomUUID()}`,
    createdAt: String(Math.floor(step.at.getTime() / 1000)),
    room: { sid: 'RM_test', name: consultRoomName(tenantId, consultId) },
    ...(step.kind === 'room_finished' ? {} : { participant: { sid: 'PA_test', identity: participantIdentity(step.who) } }),
  };
}

export async function playVideo(app: App, tenantId: string, consultId: string, steps: VideoStep[]): Promise<void> {
  for (const step of steps) {
    const reply = await postVideoWebhook(app, videoEvent(tenantId, consultId, step));
    if (reply.statusCode !== 200) throw new Error(`The video webhook answered ${reply.statusCode}`);
  }
}

/**
 * A video consult that happened: both join at `from`, both leave `seconds`
 * later, then the room closes. Returns the consult id.
 */
export async function heldConsult(
  app: App,
  tenantId: string,
  input: { patientId: string; clinicianUserId: string; from?: Date; seconds?: number },
): Promise<string> {
  const consultId = await bookConsult(tenantId, input);
  const from = input.from ?? new Date(Date.now() - 15 * 60_000);
  const to = new Date(from.getTime() + (input.seconds ?? 600) * 1000);
  const patient: Participant = { party: 'patient', patientId: input.patientId };
  const clinician: Participant = { party: 'clinician', userId: input.clinicianUserId };
  await playVideo(app, tenantId, consultId, [
    { kind: 'participant_joined', who: patient, at: from },
    { kind: 'participant_joined', who: clinician, at: from },
    { kind: 'participant_left', who: patient, at: to },
    { kind: 'participant_left', who: clinician, at: to },
    { kind: 'room_finished', at: to },
  ]);
  return consultId;
}
