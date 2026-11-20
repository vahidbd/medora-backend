import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { withTenant } from '../../db/tenant.js';
import { ForbiddenError } from '../../lib/errors.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import type { Viewer } from './access.js';
import { clearFlag, flagTicket } from './flags.service.js';
import { linkPatient, verifyPatient } from './patient-link.js';
import { addComment, logCall, replyToTicket } from './replies.service.js';
import {
  callBody,
  commentBody,
  commentReply,
  flagBody,
  flagParams,
  flagsReply,
  patientLinkBody,
  replyBody,
  ticketChangeBody,
  ticketListQuery,
  ticketListReply,
  ticketParams,
  ticketReply,
  verifyBody,
} from './support.schemas.js';
import { getTicket, listTickets, updateTicket } from './tickets.service.js';

/** The staff inbox (PRD section 13, docs/decisions/support.md). The API hides; the screen only reflects it (SUP2). */

function viewerOf(request: FastifyRequest): Viewer {
  const { auth, tenant } = requireTenant(request);
  return {
    actor: { type: 'person', userId: auth.userId },
    permissions: tenant.permissions,
    membershipId: tenant.membershipId,
  };
}

const CHANGES = ['ticket.status_changed', 'ticket.queue_changed', 'ticket.priority_changed', 'ticket.assigned'];
const personOnly = (why: string) => ({
  none: `${why} (docs/decisions/support.md SUP12)`,
});
const noEvents = (why: string) => ({ none: why });

export const supportRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { access: { permission: 'support:read' } } as const;
  const reply = { permission: 'support:reply' } as const;

  app.get(
    '/tickets',
    {
      config: read,
      schema: {
        tags: ['support'],
        summary: 'The inbox: tickets newest first',
        querystring: ticketListQuery,
        response: { 200: ticketListReply },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => listTickets(tx, viewerOf(request), request.query)),
  );

  app.get(
    '/tickets/:ticketId',
    {
      config: read,
      schema: {
        tags: ['support'],
        summary: 'One ticket, its messages and comments',
        params: ticketParams,
        response: { 200: ticketReply },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getTicket(tx, viewerOf(request), request.params.ticketId)),
  );

  app.patch(
    '/tickets/:ticketId',
    {
      config: {
        access: reply,
        audit: CHANGES,
        events: CHANGES,
        agentTool: 'support.update_ticket',
      },
      schema: {
        tags: ['support'],
        summary: "Change a ticket's status, queue, priority or assignee",
        params: ticketParams,
        body: ticketChangeBody,
        response: { 200: ticketReply },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        const viewer = viewerOf(request);
        await updateTicket(tx, viewer, request.params.ticketId, request.body);
        return getTicket(tx, viewer, request.params.ticketId);
      }),
  );

  app.post(
    '/tickets/:ticketId/replies',
    {
      config: {
        access: reply,
        audit: ['message.queued', 'message.recorded', 'ticket.status_changed'],
        events: ['message.queued', 'ticket.replied', 'ticket.status_changed'],
        agentTool: 'support.reply_to_ticket',
      },
      schema: {
        tags: ['support'],
        summary: 'Reply to the person, the way they last wrote in',
        params: ticketParams,
        body: replyBody,
        response: { 201: ticketReply },
      },
    },
    async (request, res) => {
      const ticket = await withTenant(tenantContextOf(request), async (tx) => {
        const viewer = viewerOf(request);
        await replyToTicket(tx, viewer, request.params.ticketId, request.body);
        return getTicket(tx, viewer, request.params.ticketId);
      });
      return res.code(201).send(ticket);
    },
  );

  app.post(
    '/tickets/:ticketId/calls',
    {
      config: {
        access: reply,
        audit: ['message.received', 'message.recorded', 'ticket.flagged', 'ticket.queue_changed', 'ticket.priority_changed', 'ticket.status_changed'],
        events: ['ticket.message_received', 'ticket.call_logged', 'ticket.flagged', 'ticket.queue_changed', 'ticket.priority_changed', 'ticket.status_changed'],
        agentTool: personOnly('A call is written up by the person who took it'),
      },
      schema: {
        tags: ['support'],
        summary: 'Log a phone call on a ticket: a summary, no recording',
        params: ticketParams,
        body: callBody,
        response: { 201: ticketReply },
      },
    },
    async (request, res) => {
      const ticket = await withTenant(tenantContextOf(request), async (tx) => {
        const viewer = viewerOf(request);
        await logCall(tx, viewer, request.params.ticketId, request.body);
        return getTicket(tx, viewer, request.params.ticketId);
      });
      return res.code(201).send(ticket);
    },
  );

  app.post(
    '/tickets/:ticketId/comments',
    {
      config: {
        access: reply,
        audit: ['ticket.commented'],
        events: noEvents('A comment is for staff reading the ticket; nothing reacts'),
        agentTool: personOnly('Comments are written by staff'),
      },
      schema: {
        tags: ['support'],
        summary: 'Add a comment only staff see',
        params: ticketParams,
        body: commentBody,
        response: { 201: commentReply },
      },
    },
    async (request, res) => res.code(201).send(await withTenant(tenantContextOf(request), (tx) => addComment(tx, viewerOf(request), request.params.ticketId, request.body.body))),
  );

  app.post(
    '/tickets/:ticketId/flags',
    {
      config: {
        access: reply,
        audit: ['ticket.flagged', 'ticket.queue_changed', 'ticket.priority_changed'],
        events: ['ticket.flagged', 'ticket.queue_changed', 'ticket.priority_changed'],
        agentTool: 'support.flag_ticket',
      },
      schema: {
        tags: ['support'],
        summary: 'Flag a ticket: it only ever escalates',
        params: ticketParams,
        body: flagBody,
        response: { 200: flagsReply },
      },
    },
    async (request) => ({
      flags: await withTenant(tenantContextOf(request), (tx) => flagTicket(tx, viewerOf(request), request.params.ticketId, request.body.flag)),
    }),
  );

  app.delete(
    '/tickets/:ticketId/flags/:flag',
    {
      config: {
        access: reply,
        audit: ['ticket.flag_cleared'],
        events: ['ticket.flag_cleared'],
        agentTool: personOnly('Only a person clears a flag'),
      },
      schema: {
        tags: ['support'],
        summary: 'Clear a flag',
        params: flagParams,
        response: { 200: flagsReply },
      },
    },
    async (request) => ({
      flags: await withTenant(tenantContextOf(request), (tx) => clearFlag(tx, viewerOf(request), request.params.ticketId, request.params.flag)),
    }),
  );

  app.put(
    '/tickets/:ticketId/patient',
    {
      config: {
        access: reply,
        audit: ['ticket.patient_linked', 'ticket.patient_unlinked'],
        events: ['ticket.patient_linked', 'ticket.patient_unlinked'],
        agentTool: personOnly('Staff link a patient by hand when matching finds nobody or two'),
      },
      schema: {
        tags: ['support'],
        summary: 'Link the ticket to a patient, or to nobody',
        params: ticketParams,
        body: patientLinkBody,
        response: { 200: ticketReply },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        const viewer = viewerOf(request);
        if (!viewer.permissions.has('patients:read')) throw new ForbiddenError('Linking a patient needs patients:read', 'missing_permission');
        await linkPatient(tx, viewer, request.params.ticketId, request.body.patientId);
        return getTicket(tx, viewer, request.params.ticketId);
      }),
  );

  app.post(
    '/tickets/:ticketId/verify',
    {
      config: {
        access: reply,
        audit: ['ticket.patient_verified'],
        events: ['ticket.patient_verified'],
        agentTool: personOnly('A person confirms who they are talking to'),
      },
      schema: {
        tags: ['support'],
        summary: 'Confirm who you are talking to, and how',
        params: ticketParams,
        body: verifyBody,
        response: { 200: ticketReply },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        const viewer = viewerOf(request);
        await verifyPatient(tx, viewer, request.params.ticketId, request.body.method);
        return getTicket(tx, viewer, request.params.ticketId);
      }),
  );
};
