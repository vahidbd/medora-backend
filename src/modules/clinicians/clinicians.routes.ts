import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { withTenant } from '../../db/tenant.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import {
  clinicianDetail,
  clinicianListReply,
  clinicianParams,
  createClinicianBody,
  suspendBody,
  updateClinicianBody,
} from './clinicians.schemas.js';
import { createClinician, getClinician, listClinicians, resumeClinician, suspendClinician, updateClinician } from './clinicians.service.js';
import type { Acting } from './clinicians.store.js';

/** Who is acting: managers act on anyone else; a clinician acts on their own record (WRK4). */
export function actingOf(request: FastifyRequest): Acting {
  const { auth, tenant } = requireTenant(request);
  return { userId: auth.userId, canManage: tenant.permissions.has('clinicians:manage') };
}

const NO_AGENT = { none: 'Who may see patients is decided by a person, never an agent (ADR 0012, WRK4)' } as const;
const tags = ['clinicians'];

export const clinicianRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/clinicians',
    {
      config: { access: { permission: 'clinicians:read' } },
      schema: { tags, summary: "The tenant's clinicians and whether each may consult and prescribe now", response: { 200: clinicianListReply } },
    },
    async (request) => ({ clinicians: await withTenant(tenantContextOf(request), (tx) => listClinicians(tx)) }),
  );

  app.post(
    '/clinicians',
    {
      config: { access: { permission: 'clinicians:manage' }, audit: ['clinician.created'], events: ['clinician.created'], agentTool: NO_AGENT },
      schema: { tags, summary: 'Make a staff member a clinician', body: createClinicianBody, response: { 201: clinicianDetail } },
    },
    async (request, reply) => {
      const created = await withTenant(tenantContextOf(request), (tx) => createClinician(tx, request.body, actingOf(request)));
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/clinicians/:clinicianId',
    {
      config: { access: { permission: 'clinicians:read' } },
      schema: {
        tags,
        summary: 'One clinician: standing, hours and time off, and credentials for a manager or the clinician',
        params: clinicianParams,
        response: { 200: clinicianDetail },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getClinician(tx, request.params.clinicianId, actingOf(request))),
  );

  app.patch(
    '/clinicians/:clinicianId',
    {
      config: { access: { permission: 'clinicians:manage' }, audit: ['clinician.updated'], events: ['clinician.updated'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: "Change a clinician's profession or time zone",
        params: clinicianParams,
        body: updateClinicianBody,
        response: { 200: clinicianDetail },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) => updateClinician(tx, request.params.clinicianId, request.body, actingOf(request))),
  );

  app.post(
    '/clinicians/:clinicianId/suspend',
    {
      config: { access: { permission: 'clinicians:manage' }, audit: ['clinician.suspended'], events: ['clinician.suspended'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: 'Stop a clinician booking or starting consults now',
        params: clinicianParams,
        body: suspendBody,
        response: { 200: clinicianDetail },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) => suspendClinician(tx, request.params.clinicianId, request.body.reason, actingOf(request))),
  );

  app.post(
    '/clinicians/:clinicianId/resume',
    {
      config: { access: { permission: 'clinicians:manage' }, audit: ['clinician.resumed'], events: ['clinician.resumed'], agentTool: NO_AGENT },
      schema: { tags, summary: "Lift a clinician's suspension", params: clinicianParams, response: { 200: clinicianDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => resumeClinician(tx, request.params.clinicianId, actingOf(request))),
  );
};
