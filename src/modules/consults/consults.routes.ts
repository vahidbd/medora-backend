import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { bookConsult, cancelConsult, markNoShow, reinstateConsult, rescheduleConsult } from './booking.service.js';
import { bookBody, cancelBody, consultParams, rescheduleBody, scheduleEntry, scheduleQuery, scheduleReply, slotsQuery, slotsReply } from './consults.schemas.js';
import { readConsult, readSchedule, readSlots, scheduleEntry as entryOf } from './schedule.service.js';

/**
 * The consult schedule and booking (docs/decisions/consults.md CNS11 to
 * CNS16). Agents may book, move and cancel through the same services; only a
 * person marks or reinstates a no-show.
 */

const tags = ['consults'];
const read = { permission: 'consults:read' } as const;
const book = { permission: 'consults:book' } as const;
const PEOPLE_ONLY = { none: 'Whether a patient came is for a person to say (CNS16); the service refuses an agent' } as const;

export const consultsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/consults',
    {
      config: { access: read },
      schema: { tags, summary: 'Consults starting in a range, for one clinician or patient if asked', querystring: scheduleQuery, response: { 200: scheduleReply } },
    },
    async (request) => ({ consults: await withTenant(tenantContextOf(request), (tx) => readSchedule(tx, request.query)) }),
  );

  app.get(
    '/consults/slots',
    {
      config: { access: read },
      schema: { tags, summary: "A clinician's free slots, in their time zone's hours", querystring: slotsQuery, response: { 200: slotsReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => readSlots(tx, request.query)),
  );

  app.get(
    '/consults/:consultId',
    {
      config: { access: read },
      schema: { tags, summary: 'One consult in the schedule', params: consultParams, response: { 200: scheduleEntry } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => readConsult(tx, request.params.consultId)),
  );

  app.post(
    '/consults',
    {
      config: { access: book, audit: ['consult.booked'], events: ['consult.booked'], agentTool: 'book_consult' },
      schema: { tags, summary: 'Book a consult in a free slot', body: bookBody, response: { 201: scheduleEntry } },
    },
    async (request, reply) => {
      const entry = await withTenant(tenantContextOf(request), async (tx) => entryOf(tx, await bookConsult(tx, request.body)));
      return reply.code(201).send(entry);
    },
  );

  app.post(
    '/consults/:consultId/reschedule',
    {
      config: { access: book, audit: ['consult.rescheduled', 'consult.booked'], events: ['consult.rescheduled'], agentTool: 'reschedule_consult' },
      schema: { tags, summary: 'Move a consult: cancel it and book the new time, together', params: consultParams, body: rescheduleBody, response: { 201: scheduleEntry } },
    },
    async (request, reply) => {
      const entry = await withTenant(tenantContextOf(request), async (tx) => entryOf(tx, await rescheduleConsult(tx, request.params.consultId, request.body)));
      return reply.code(201).send(entry);
    },
  );

  app.post(
    '/consults/:consultId/cancel',
    {
      config: { access: book, audit: ['consult.cancelled'], events: ['consult.cancelled'], agentTool: 'cancel_consult' },
      schema: { tags, summary: 'Cancel a scheduled consult that hasn’t started', params: consultParams, body: cancelBody, response: { 200: scheduleEntry } },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => entryOf(tx, await cancelConsult(tx, request.params.consultId, request.body.reason))),
  );

  app.post(
    '/consults/:consultId/no-show',
    {
      config: { access: book, audit: ['consult.marked_no_show'], events: ['consult.marked_no_show'], agentTool: PEOPLE_ONLY },
      schema: { tags, summary: 'Record that the patient didn’t come to a consult that was due', params: consultParams, response: { 200: scheduleEntry } },
    },
    async (request) => withTenant(tenantContextOf(request), async (tx) => entryOf(tx, await markNoShow(tx, request.params.consultId))),
  );

  app.post(
    '/consults/:consultId/reinstate',
    {
      config: { access: book, audit: ['consult.reinstated'], events: ['consult.reinstated'], agentTool: PEOPLE_ONLY },
      schema: { tags, summary: 'Undo a mistaken no-show', params: consultParams, response: { 200: scheduleEntry } },
    },
    async (request) => withTenant(tenantContextOf(request), async (tx) => entryOf(tx, await reinstateConsult(tx, request.params.consultId))),
  );
};
