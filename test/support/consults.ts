import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { App } from '../../src/app.js';
import type { ConsultMode } from '../../src/db/schema/values.js';
import { consultRoomName, participantIdentity, type Participant } from '../../src/modules/consults/index.js';
import { addMember, admin, createUser } from './db.js';

/**
 * Patients, prescribers and consults for tests (docs/decisions/consults.md).
 * Made-up people only. Consult evidence is never inserted: a test plays the
 * video server, sending signed callbacks to the real webhook route, so the
 * signature check, the inbox and the handler all run as they do in production.
 * Build the app (testApp) before calling these.
 */

export async function createPatient(tenantId: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into clinical.patients (tenant_id, given_name, family_name, date_of_birth, sex) values ($1, 'Sam', 'Example', '1988-03-14', 'not_stated') returning id`,
    [tenantId],
  );
  return rows[0]!.id;
}

/**
 * A doctor who may consult and prescribe: a prescriber membership, a clinician
 * profile, and a registration and indemnity someone else has checked.
 */
export async function createPrescriber(tenantId: string): Promise<{ userId: string; email: string; clinicianId: string }> {
  const person = await createUser();
  const checker = await createUser();
  const membershipId = await addMember(tenantId, person.id, 'prescriber');
  await addMember(tenantId, checker.id, 'medical_director');
  const { rows } = await admin.query<{ id: string }>(
    `insert into operational.clinicians (tenant_id, membership_id, profession, time_zone) values ($1, $2, 'medical_practitioner', 'Australia/Sydney') returning id`,
    [tenantId, membershipId],
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

/** A scheduled consult. Booking writes these through its service once it lands. */
export async function bookConsult(tenantId: string, input: { patientId: string; clinicianUserId: string; mode?: ConsultMode }): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into clinical.consults (tenant_id, patient_id, clinician_user_id, mode) values ($1, $2, $3, $4) returning id`,
    [tenantId, input.patientId, input.clinicianUserId, input.mode ?? 'video'],
  );
  return rows[0]!.id;
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
