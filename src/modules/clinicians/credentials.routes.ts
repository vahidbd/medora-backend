import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { actingOf } from './clinicians.routes.js';
import {
  addCredentialBody,
  addTimeOffBody,
  clinicianDetail,
  clinicianParams,
  credentialParams,
  hoursReply,
  removedReply,
  replaceHoursBody,
  timeOffParams,
  timeOffSchema,
  withdrawCredentialBody,
} from './clinicians.schemas.js';
import { addCredential, reviewConditions, verifyCredential, withdrawCredential } from './credentials.service.js';
import { addTimeOff, removeTimeOff, replaceHours } from './schedule.service.js';

/**
 * Credentials, hours and time off. These routes need clinicians:read; the
 * services then let a clinician act on their own record and a manager act on
 * anyone's, except that checking a credential is always someone else (WRK4).
 */

const NO_AGENT = { none: 'Credentials are recorded and checked by people, never an agent (ADR 0012, WRK4)' } as const;
const tags = ['clinicians'];
const access = { permission: 'clinicians:read' } as const;

export const credentialRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/clinicians/:clinicianId/credentials',
    {
      config: { access, audit: ['credential.added'], events: ['credential.added'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: 'Record a registration, endorsement or indemnity policy, to be checked by someone else',
        params: clinicianParams,
        body: addCredentialBody,
        response: { 201: clinicianDetail },
      },
    },
    async (request, reply) => {
      const detail = await withTenant(tenantContextOf(request), (tx) => addCredential(tx, request.params.clinicianId, request.body, actingOf(request)));
      return reply.code(201).send(detail);
    },
  );

  app.post(
    '/clinicians/:clinicianId/credentials/:credentialId/verify',
    {
      config: { access, audit: ['credential.verified'], events: ['credential.verified'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: 'Record that a credential was checked against the register or the policy today',
        params: credentialParams,
        response: { 200: clinicianDetail },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) =>
        verifyCredential(tx, request.params.clinicianId, request.params.credentialId, actingOf(request)),
      ),
  );

  app.post(
    '/clinicians/:clinicianId/credentials/:credentialId/review-conditions',
    {
      config: { access, audit: ['credential.conditions_reviewed'], events: ['credential.conditions_reviewed'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: 'Record that the conditions on a registration were read and allow this work',
        params: credentialParams,
        response: { 200: clinicianDetail },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) =>
        reviewConditions(tx, request.params.clinicianId, request.params.credentialId, actingOf(request)),
      ),
  );

  app.post(
    '/clinicians/:clinicianId/credentials/:credentialId/withdraw',
    {
      config: { access, audit: ['credential.withdrawn'], events: ['credential.withdrawn'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: 'Withdraw a credential entered in error or no longer held',
        params: credentialParams,
        body: withdrawCredentialBody,
        response: { 200: clinicianDetail },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) =>
        withdrawCredential(tx, request.params.clinicianId, request.params.credentialId, request.body.reason, actingOf(request)),
      ),
  );

  app.put(
    '/clinicians/:clinicianId/hours',
    {
      config: {
        access,
        audit: ['clinician.hours_changed'],
        events: ['clinician.hours_changed'],
        agentTool: { none: 'A clinician or a manager sets working hours (WRK6)' },
      },
      schema: {
        tags,
        summary: "Replace a clinician's weekly working hours, in their own time zone",
        params: clinicianParams,
        body: replaceHoursBody,
        response: { 200: hoursReply },
      },
    },
    async (request) => ({
      hours: await withTenant(tenantContextOf(request), (tx) => replaceHours(tx, request.params.clinicianId, request.body.hours, actingOf(request))),
    }),
  );

  app.post(
    '/clinicians/:clinicianId/time-off',
    {
      config: {
        access,
        audit: ['clinician.time_off_added'],
        events: ['clinician.time_off_added'],
        agentTool: { none: 'A clinician or a manager records time off (WRK7)' },
      },
      schema: { tags, summary: 'Record time a clinician is away', params: clinicianParams, body: addTimeOffBody, response: { 201: timeOffSchema } },
    },
    async (request, reply) => {
      const added = await withTenant(tenantContextOf(request), (tx) => addTimeOff(tx, request.params.clinicianId, request.body, actingOf(request)));
      return reply.code(201).send(added);
    },
  );

  app.delete(
    '/clinicians/:clinicianId/time-off/:timeOffId',
    {
      config: {
        access,
        audit: ['clinician.time_off_removed'],
        events: ['clinician.time_off_removed'],
        agentTool: { none: 'A clinician or a manager records time off (WRK7)' },
      },
      schema: { tags, summary: 'Remove time off, so the clinician can be booked then again', params: timeOffParams, response: { 200: removedReply } },
    },
    async (request) => {
      await withTenant(tenantContextOf(request), (tx) => removeTimeOff(tx, request.params.clinicianId, request.params.timeOffId, actingOf(request)));
      return { removed: true as const };
    },
  );
};
