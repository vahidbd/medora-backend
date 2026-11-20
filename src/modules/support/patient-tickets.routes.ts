import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withPublic, withTenant } from '../../db/tenant.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { resolvePublicBrand } from '../brands/index.js';
import { getPatientTicket, listPatientTickets, openPatientTicket, postPatientMessage } from './patient-tickets.service.js';
import { patientMessageBody, patientTicketBody, patientTicketListReply, patientTicketReply, ticketParams } from './support.schemas.js';

/** The patient app's Messages, under /v1/patient (APP-04, docs/decisions/support.md SUP13). */

const NO_AGENT = {
  none: 'A patient writes their own messages; an agent never acts as a patient (ADR 0012)',
};
const AUDIT = ['message.received', 'ticket.created', 'ticket.flagged', 'ticket.viewed', 'message.queued', 'message.recorded'];
const EVENTS = ['ticket.created', 'ticket.message_received', 'ticket.flagged', 'ticket.queue_changed', 'ticket.priority_changed', 'ticket.status_changed'];

/**
 * The brand the patient app is served under: the web app's relay names the
 * host it was opened on. It is only a label, so a host that matches none of
 * this tenant's verified domains records no brand rather than refusing.
 */
async function brandOf(request: FastifyRequest): Promise<string | null> {
  const host = request.headers['x-medora-brand-host'];
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return null;
  const resolved = await withPublic((tx) => resolvePublicBrand(tx, { host }));
  return resolved && resolved.tenantId === requirePatient(request).tenantId ? resolved.brandId : null;
}

export const patientTicketRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/patient/tickets',
    {
      config: { access: 'patient' },
      schema: {
        tags: ['support'],
        summary: 'Your tickets with the team',
        response: { 200: patientTicketListReply },
      },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => listPatientTickets(tx, requirePatient(request).patientId)),
  );

  app.post(
    '/patient/tickets',
    {
      config: {
        access: 'patient',
        audit: AUDIT,
        events: EVENTS,
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['support'],
        summary: 'Open a ticket with the team',
        body: patientTicketBody,
        response: { 201: patientTicketReply },
      },
    },
    async (request, reply) => {
      const brandId = await brandOf(request);
      const ticket = await withTenant(patientContextOf(request), (tx) => openPatientTicket(tx, requirePatient(request).patientId, { ...request.body, brandId }));
      return reply.code(201).send(ticket);
    },
  );

  app.get(
    '/patient/tickets/:ticketId',
    {
      config: { access: 'patient' },
      schema: {
        tags: ['support'],
        summary: 'One ticket',
        params: ticketParams,
        response: { 200: patientTicketReply },
      },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => getPatientTicket(tx, requirePatient(request).patientId, request.params.ticketId)),
  );

  app.post(
    '/patient/tickets/:ticketId/messages',
    {
      config: {
        access: 'patient',
        audit: AUDIT,
        events: EVENTS,
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['support'],
        summary: 'Write on a ticket',
        params: ticketParams,
        body: patientMessageBody,
        response: { 201: patientTicketReply },
      },
    },
    async (request, reply) => {
      const ticket = await withTenant(patientContextOf(request), (tx) => postPatientMessage(tx, requirePatient(request).patientId, request.params.ticketId, request.body.body));
      return reply.code(201).send(ticket);
    },
  );
};
