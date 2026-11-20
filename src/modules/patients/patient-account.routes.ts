import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { ForbiddenError, NotFoundError, TooManyRequestsError } from '../../lib/errors.js';
import { blockedFor, countAttempt } from '../../lib/rate-limit.js';
import { patientContextOf, requirePatient, signInContextOf } from '../../plugins/patient-auth.js';
import { changeProfile, confirmDateOfBirth, createAccount, DATE_OF_BIRTH_LIMIT } from './patient-account.service.js';
import { accountBody, confirmDateOfBirthBody, confirmedReply, patientMeReply, profileChangeBody } from './patients.schemas.js';
import { getPatientProfile } from './patients.service.js';
import type { TenantTx } from '../../db/tenant.js';

/** What a patient does with their own account, under /v1/patient (ADR 0035, docs/decisions/patients.md). */

const NO_AGENT = { none: 'A patient creates and changes their own account; an agent never acts as a patient (ADR 0012)' };

async function meOf(tx: TenantTx, patientId: string) {
  const profile = await getPatientProfile(tx, patientId);
  if (!profile) throw new NotFoundError('Patient');
  return { ...profile, consentsNeeded: [], programs: [] };
}

export const patientAccountRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/patient/account',
    {
      config: { access: 'patient-sign-in', audit: ['patient.created', 'patient.read'], events: ['patient.created'], agentTool: NO_AGENT },
      schema: { tags: ['patients'], summary: 'Create the signed-in patient’s account in this tenant', body: accountBody, response: { 201: patientMeReply } },
    },
    async (request, reply) => {
      const sign = request.patient!;
      const me = await withTenant(signInContextOf(request), async (tx) => {
        const patientId = await createAccount(tx, sign, request.body);
        return meOf({ ...tx, context: { ...tx.context, actor: { type: 'patient', patientId } } }, patientId);
      });
      return reply.code(201).send(me);
    },
  );

  app.post(
    '/patient/confirm-date-of-birth',
    {
      config: {
        access: 'patient-sign-in',
        audit: ['patient.sign_in_confirmed', 'patient.date_of_birth_refused'],
        events: { none: 'A sign-in check; nothing else reacts to it' },
        agentTool: NO_AGENT,
      },
      schema: { tags: ['patients'], summary: 'Confirm the date of birth on a new sign-in', body: confirmDateOfBirthBody, response: { 200: confirmedReply } },
    },
    async (request) => {
      const sign = request.patient!;
      if (!sign.patientId) throw new ForbiddenError('Create your account first', 'no_patient_record');
      const subject = `${sign.tenantId}:${sign.patientId}`;
      const retryAfter = await blockedFor(DATE_OF_BIRTH_LIMIT, subject);
      if (retryAfter !== null) throw new TooManyRequestsError(retryAfter);
      const confirmed = await withTenant(signInContextOf(request), (tx) => confirmDateOfBirth(tx, sign, request.body.dateOfBirth));
      if (!confirmed) {
        await countAttempt(DATE_OF_BIRTH_LIMIT, subject);
        throw new ForbiddenError("That date of birth doesn't match your account", 'date_of_birth_mismatch');
      }
      return { confirmed: true as const };
    },
  );

  app.get(
    '/patient/me',
    {
      config: { access: 'patient' },
      schema: { tags: ['patients'], summary: 'The signed-in patient’s own details', response: { 200: patientMeReply } },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => meOf(tx, requirePatient(request).patientId)),
  );

  app.patch(
    '/patient/me',
    {
      config: { access: 'patient', audit: ['patient.updated', 'patient.read'], events: ['patient.updated'], agentTool: NO_AGENT },
      schema: { tags: ['patients'], summary: 'Change the signed-in patient’s own details', body: profileChangeBody, response: { 200: patientMeReply } },
    },
    async (request) =>
      withTenant(patientContextOf(request), async (tx) => {
        const { patientId } = requirePatient(request);
        await changeProfile(tx, patientId, request.body);
        return meOf(tx, patientId);
      }),
  );
};
