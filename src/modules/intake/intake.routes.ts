import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { type TenantContext, withTenant } from '../../db/tenant.js';
import { BadRequestError, NotFoundError, TooManyRequestsError } from '../../lib/errors.js';
import { blockedFor, countAttempt, type Limit } from '../../lib/rate-limit.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { PATIENT_TENANT_HEADER, patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { findPatient } from '../patients/index.js';
import {
  anonymousStartBody,
  claimBody,
  claimReply,
  intakeList,
  intakeParams,
  intakeSummary as intakeSummaryReply,
  intakeView,
  patientParams,
  patientStartBody,
  programParams,
  startScreenReply,
  stepBody,
  stepParams,
} from './intake.schemas.js';
import { claimIntakes, readIntake, saveStep, startAnonymous, startForPatient, startScreen, submitIntake } from './intakes.service.js';
import { intakeSummary, intakesOf } from './summary.service.js';
import { settleIntakes } from './upkeep.js';

/**
 * Intakes (docs/decisions/intake.md INT5 to INT15): anonymous routes under
 * /v1/public for a brand site before an account, the same steps for a
 * signed-in patient under /v1/patient, and staff reads.
 */

export const INTAKE_TOKEN_HEADER = 'x-medora-intake-token';
/** Starting is the one anonymous write that makes a row: per address, and per tenant so many addresses can't flood one. */
export const INTAKE_START_LIMIT: Limit = { name: 'intake-start', max: 20, windowSeconds: 3600 };
export const INTAKE_TENANT_START_LIMIT: Limit = { name: 'intake-start-tenant', max: 2000, windowSeconds: 3600 };
/** Wrong resume tokens per address, so a token can't be guessed. */
export const INTAKE_TOKEN_LIMIT: Limit = { name: 'intake-token', max: 30, windowSeconds: 300 };

const AGENT_LATER = { none: 'The intake agent comes later and will use these same routes, as the patient (ADR 0012)' };
const PATIENT_ONLY = { none: 'Claiming intakes is the patient’s own act after signing in; an agent never does it (ADR 0012)' };
const ENDED = ['intake.ended'];
/** Lapses an intake may reach as it is opened (INT7, INT14). */
const LAPSES = ['intake.cleared', 'intake.lapsed'];

/** Apply a lapse in its own transaction first, so a refusal that follows can't roll it back. */
const settleFirst = (context: TenantContext, intakeId: string) => withTenant(context, (tx) => settleIntakes(tx, { intakeId }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An anonymous request names its tenant like a patient one (IDN4); nobody is signed in, so the system acts (INT5). */
function publicContext(request: FastifyRequest): TenantContext {
  const raw = request.headers[PATIENT_TENANT_HEADER];
  const tenantId = Array.isArray(raw) ? raw[0] : raw;
  if (!tenantId || !UUID.test(tenantId)) throw new BadRequestError(`${PATIENT_TENANT_HEADER} must be a tenant id`, 'tenant_required');
  return { tenantId: tenantId.toLowerCase(), actor: { type: 'system' }, requestId: request.id };
}

async function underLimit(limit: Limit, subject: string): Promise<void> {
  const { count, retryAfterSeconds } = await countAttempt(limit, subject);
  if (count > limit.max) throw new TooManyRequestsError(retryAfterSeconds);
}

/** Run work as the holder of the resume token in the request; a wrong token counts against the address. */
async function asTokenHolder<T>(request: FastifyRequest, work: (context: TenantContext, holder: { token: string }) => Promise<T>): Promise<T> {
  const raw = request.headers[INTAKE_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) throw new BadRequestError(`Send the intake's resume token in ${INTAKE_TOKEN_HEADER}`, 'intake_token_required');
  const retryAfter = await blockedFor(INTAKE_TOKEN_LIMIT, request.clientIp);
  if (retryAfter !== null) throw new TooManyRequestsError(retryAfter);
  const context = publicContext(request);
  try {
    return await work(context, { token });
  } catch (error) {
    if (error instanceof NotFoundError && error.message === 'Intake not found') await countAttempt(INTAKE_TOKEN_LIMIT, request.clientIp);
    throw error;
  }
}

export const intakeRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/public/programs/:programId/intake-start',
    {
      config: { access: 'public' },
      schema: { tags: ['intakes'], summary: 'What the first screen of an intake shows: the program and the privacy notice', params: programParams, response: { 200: startScreenReply } },
    },
    async (request) => withTenant(publicContext(request), (tx) => startScreen(tx, request.params.programId)),
  );

  app.post(
    '/public/intakes',
    {
      config: { access: 'public', audit: ['intake.started'], events: ['intake.started', 'intake.ended'], agentTool: AGENT_LATER },
      schema: {
        tags: ['intakes'],
        summary: 'Start an intake before signing up. The resume token comes back once, in the x-medora-intake-token header, never in the body',
        body: anonymousStartBody,
        response: { 201: intakeView },
      },
    },
    async (request, reply) => {
      const context = publicContext(request);
      await underLimit(INTAKE_START_LIMIT, request.clientIp);
      await underLimit(INTAKE_TENANT_START_LIMIT, context.tenantId);
      const { resumeToken, intake } = await withTenant(context, (tx) => startAnonymous(tx, request.body));
      // A credential never travels in a reply body (src/lib/response-schema.ts). The patient app's server moves it into an httpOnly cookie (INT5).
      return reply.code(201).header(INTAKE_TOKEN_HEADER, resumeToken).header('cache-control', 'no-store').send(intake);
    },
  );

  app.get(
    '/public/intakes/:intakeId',
    { config: { access: 'public' }, schema: { tags: ['intakes'], summary: 'An intake started before signing up, with its answers', params: intakeParams, response: { 200: intakeView } } },
    async (request) =>
      asTokenHolder(request, async (context, holder) => {
        await settleFirst(context, request.params.intakeId);
        return withTenant(context, (tx) => readIntake(tx, request.params.intakeId, holder));
      }),
  );

  app.put(
    '/public/intakes/:intakeId/steps/:stepKey',
    {
      config: { access: 'public', audit: ['intake.answered', 'intake.ineligible', ...LAPSES], events: ENDED, agentTool: AGENT_LATER },
      schema: { tags: ['intakes'], summary: 'Answer one step of an intake started before signing up', params: stepParams, body: stepBody, response: { 200: intakeView } },
    },
    async (request) =>
      asTokenHolder(request, async (context, holder) => {
        await settleFirst(context, request.params.intakeId);
        return withTenant(context, (tx) => saveStep(tx, request.params.intakeId, holder, request.params.stepKey, request.body.answers));
      }),
  );

  app.get(
    '/patient/intakes',
    { config: { access: 'patient' }, schema: { tags: ['intakes'], summary: 'The signed-in patient’s intakes', response: { 200: intakeList } } },
    async (request) => ({ intakes: await withTenant(patientContextOf(request), (tx) => intakesOf(tx, requirePatient(request).patientId)) }),
  );

  app.post(
    '/patient/intakes',
    {
      config: { access: 'patient', audit: ['intake.started'], events: ['intake.started'], agentTool: AGENT_LATER },
      schema: { tags: ['intakes'], summary: 'Start an intake, or pick up the one in progress for that program', body: patientStartBody, response: { 201: intakeView } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(patientContextOf(request), (tx) => startForPatient(tx, requirePatient(request).patientId, request.body.programId))),
  );

  app.post(
    '/patient/intakes/claim',
    {
      config: { access: 'patient', audit: ['intake.claimed', 'consent.given', ...LAPSES], events: ['consent.given', 'intake.ended'], agentTool: PATIENT_ONLY },
      schema: { tags: ['intakes'], summary: 'Make the intakes started in this browser the patient’s own', body: claimBody, response: { 200: claimReply } },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => claimIntakes(tx, requirePatient(request).patientId, request.body.tokens)),
  );

  app.get(
    '/patient/intakes/:intakeId',
    { config: { access: 'patient' }, schema: { tags: ['intakes'], summary: 'One of the signed-in patient’s intakes, with its answers', params: intakeParams, response: { 200: intakeView } } },
    async (request) => {
      const context = patientContextOf(request);
      await settleFirst(context, request.params.intakeId);
      return withTenant(context, (tx) => readIntake(tx, request.params.intakeId, { patientId: requirePatient(request).patientId }));
    },
  );

  app.put(
    '/patient/intakes/:intakeId/steps/:stepKey',
    {
      config: { access: 'patient', audit: ['intake.answered', 'intake.ineligible', ...LAPSES], events: ENDED, agentTool: AGENT_LATER },
      schema: { tags: ['intakes'], summary: 'Answer one step of an intake', params: stepParams, body: stepBody, response: { 200: intakeView } },
    },
    async (request) => {
      const context = patientContextOf(request);
      await settleFirst(context, request.params.intakeId);
      return withTenant(context, (tx) => saveStep(tx, request.params.intakeId, { patientId: requirePatient(request).patientId }, request.params.stepKey, request.body.answers));
    },
  );

  app.post(
    '/patient/intakes/:intakeId/submit',
    {
      config: { access: 'patient', audit: ['intake.submitted', 'intake.ineligible', ...LAPSES], events: ['intake.completed', 'intake.ended'], agentTool: AGENT_LATER },
      schema: { tags: ['intakes'], summary: 'Send a finished intake to the prescriber', params: intakeParams, response: { 200: intakeView } },
    },
    async (request) => {
      const context = patientContextOf(request);
      await settleFirst(context, request.params.intakeId);
      return withTenant(context, (tx) => submitIntake(tx, request.params.intakeId, requirePatient(request).patientId));
    },
  );

  app.get(
    '/patients/:patientId/intakes',
    {
      config: { access: { permission: 'patients:read' } },
      schema: { tags: ['intakes'], summary: 'A patient’s intakes and where each stands, without answers', params: patientParams, response: { 200: intakeList } },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        if (!(await findPatient(tx, request.params.patientId))) throw new NotFoundError('Patient');
        return { intakes: await intakesOf(tx, request.params.patientId) };
      }),
  );

  app.get(
    '/intakes/:intakeId',
    {
      config: { access: { permission: 'intakes:read' } },
      schema: { tags: ['intakes'], summary: 'A finished intake summarised for the prescriber: answers, red flags and earlier hard stops', params: intakeParams, response: { 200: intakeSummaryReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => intakeSummary(tx, request.params.intakeId)),
  );
};
