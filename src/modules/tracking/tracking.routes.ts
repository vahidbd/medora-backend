import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { checkInsOf, submitCheckIn } from './check-ins.service.js';
import { measurementsOf, recordMeasurements } from './measurements.service.js';
import { reportSideEffect, sideEffectForCareTeam, sideEffectsOf } from './side-effects.service.js';
import {
  careTeamSideEffect,
  checkIn,
  checkInBody,
  checkInsReply,
  measurementsBody,
  measurementsQuery,
  measurementsReply,
  sideEffect,
  sideEffectBody,
  sideEffectParams,
  sideEffectsReply,
} from './tracking.schemas.js';

/**
 * What a patient records about themselves, under /v1/patient
 * (docs/decisions/tracking.md). Every patient route is on the patient's own
 * record only: the patient comes from the sign-in, never from the request.
 * The care team reads a side effect report through /v1/side-effects.
 */

const NO_AGENT = { none: 'A patient records their own readings, side effects and check-ins; an agent never acts as a patient (ADR 0012)' };

export const trackingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/patient/measurements',
    {
      config: { access: 'patient' },
      schema: { tags: ['tracking'], summary: 'The signed-in patient’s measurements, newest first', querystring: measurementsQuery, response: { 200: measurementsReply } },
    },
    async (request) => ({
      measurements: await withTenant(patientContextOf(request), (tx) => measurementsOf(tx, requirePatient(request).patientId, request.query.kind)),
    }),
  );

  app.post(
    '/patient/measurements',
    {
      config: { access: 'patient', audit: ['measurement.recorded', 'adherence_activity.recorded'], events: ['measurement.recorded'], agentTool: NO_AGENT },
      schema: { tags: ['tracking'], summary: 'Record readings the patient took', body: measurementsBody, response: { 201: measurementsReply } },
    },
    async (request, reply) => {
      const { readings, measuredAt } = request.body;
      const recorded = await withTenant(patientContextOf(request), (tx) =>
        recordMeasurements(tx, { patientId: requirePatient(request).patientId, readings, measuredAt: measuredAt ? new Date(measuredAt) : undefined }),
      );
      return reply.code(201).send({ measurements: recorded });
    },
  );

  app.get(
    '/patient/side-effects',
    {
      config: { access: 'patient' },
      schema: { tags: ['tracking'], summary: 'The side effects the signed-in patient has reported', response: { 200: sideEffectsReply } },
    },
    async (request) => ({ sideEffects: await withTenant(patientContextOf(request), (tx) => sideEffectsOf(tx, requirePatient(request).patientId)) }),
  );

  app.post(
    '/patient/side-effects',
    {
      config: {
        access: 'patient',
        audit: ['side_effect.reported', 'adherence_flag.raised', 'adherence_activity.recorded'],
        events: ['side_effect.reported', 'adherence_flag.raised'],
        agentTool: NO_AGENT,
      },
      schema: { tags: ['tracking'], summary: 'Report a side effect', body: sideEffectBody, response: { 201: sideEffect } },
    },
    async (request, reply) => {
      const reported = await withTenant(patientContextOf(request), (tx) => reportSideEffect(tx, { patientId: requirePatient(request).patientId, ...request.body }));
      return reply.code(201).send(reported);
    },
  );

  // The care team reads the report behind an adherence flag (docs/decisions/adherence.md ADH10).
  app.get(
    '/side-effects/:sideEffectId',
    {
      config: { access: { permission: 'adherence:read' } },
      schema: { tags: ['tracking'], summary: 'A side effect report, in the patient’s words', params: sideEffectParams, response: { 200: careTeamSideEffect } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => sideEffectForCareTeam(tx, request.params.sideEffectId)),
  );

  app.get(
    '/patient/check-ins',
    {
      config: { access: 'patient' },
      schema: { tags: ['tracking'], summary: 'The signed-in patient’s check-ins, newest first', response: { 200: checkInsReply } },
    },
    async (request) => ({ checkIns: await withTenant(patientContextOf(request), (tx) => checkInsOf(tx, requirePatient(request).patientId)) }),
  );

  app.post(
    '/patient/check-ins',
    {
      config: {
        access: 'patient',
        audit: ['check_in.submitted', 'measurement.recorded', 'side_effect.reported', 'adherence_flag.raised', 'adherence_activity.recorded'],
        events: ['check_in.submitted', 'measurement.recorded', 'side_effect.reported', 'adherence_flag.raised'],
        agentTool: NO_AGENT,
      },
      schema: { tags: ['tracking'], summary: 'Submit a check-in', body: checkInBody, response: { 201: checkIn } },
    },
    async (request, reply) => {
      const submitted = await withTenant(patientContextOf(request), (tx) => submitCheckIn(tx, requirePatient(request).patientId, request.body));
      return reply.code(201).send(submitted);
    },
  );
};
