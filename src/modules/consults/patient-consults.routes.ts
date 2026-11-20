import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { consultParams, patientBookBody, patientConsult, patientConsultsReply, patientRescheduleBody, patientSlotsQuery, slotsReply } from './consults.schemas.js';
import { bookForPatient, cancelForPatient, consultsOfPatient, rescheduleForPatient } from './patient-consults.service.js';
import { readSlots } from './schedule.service.js';

/**
 * The patient's own consults (docs/decisions/consults.md CNS21 to CNS23).
 * Agents act for the clinic through the staff routes, never as the patient.
 */

const tags = ['consults'];
const STAFF_SIDE = { none: 'Agents book for the clinic through the staff routes (book_consult and the rest), never as the patient' } as const;

export const patientConsultsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/patient/consults',
    {
      config: { access: 'patient' },
      schema: { tags, summary: 'The signed-in patient’s consults: what’s coming, then the last 20', response: { 200: patientConsultsReply } },
    },
    async (request) => ({ consults: await withTenant(patientContextOf(request), (tx) => consultsOfPatient(tx, requirePatient(request).patientId)) }),
  );

  app.get(
    '/patient/consults/slots',
    {
      config: { access: 'patient' },
      schema: { tags, summary: 'Times the patient can book, across the clinicians who could take it', querystring: patientSlotsQuery, response: { 200: slotsReply } },
    },
    async (request) => {
      requirePatient(request);
      return withTenant(patientContextOf(request), (tx) => readSlots(tx, request.query));
    },
  );

  app.post(
    '/patient/consults',
    {
      config: { access: 'patient', audit: ['consult.booked', 'intake.outcome_read', 'patient.read'], events: ['consult.booked'], agentTool: STAFF_SIDE },
      schema: { tags, summary: 'Book a first consult or a review at one of the offered times', body: patientBookBody, response: { 201: patientConsult } },
    },
    async (request, reply) => {
      const { patientId } = requirePatient(request);
      return reply.code(201).send(await withTenant(patientContextOf(request), (tx) => bookForPatient(tx, patientId, request.body)));
    },
  );

  app.post(
    '/patient/consults/:consultId/reschedule',
    {
      config: { access: 'patient', audit: ['consult.rescheduled', 'consult.booked', 'patient.read'], events: ['consult.rescheduled'], agentTool: STAFF_SIDE },
      schema: { tags, summary: 'Move the patient’s consult to another offered time', params: consultParams, body: patientRescheduleBody, response: { 201: patientConsult } },
    },
    async (request, reply) => {
      const { patientId } = requirePatient(request);
      return reply.code(201).send(await withTenant(patientContextOf(request), (tx) => rescheduleForPatient(tx, patientId, request.params.consultId, request.body)));
    },
  );

  app.post(
    '/patient/consults/:consultId/cancel',
    {
      config: { access: 'patient', audit: ['consult.cancelled'], events: ['consult.cancelled'], agentTool: STAFF_SIDE },
      schema: { tags, summary: 'Cancel the patient’s consult', params: consultParams, response: { 200: patientConsult } },
    },
    async (request) => {
      const { patientId } = requirePatient(request);
      return withTenant(patientContextOf(request), (tx) => cancelForPatient(tx, patientId, request.params.consultId));
    },
  );
};
