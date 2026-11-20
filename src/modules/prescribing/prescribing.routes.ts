import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { UnauthorizedError } from '../../lib/errors.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { openedSessionReply, openParchmentBody } from './prescribing.schemas.js';
import { openParchment } from './sessions.service.js';

export const prescribingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/prescribing-sessions',
    {
      config: {
        access: { permission: 'prescribing:open' },
        audit: ['prescribing_session.opened', 'parchment_patient.sent', 'parchment_prescriber.linked'],
        events: ['prescribing_session.opened'],
        agentTool: { none: 'Only a prescriber opens Parchment, after speaking with the patient (ADRs 0009, 0012)' },
      },
      schema: {
        tags: ['prescribing'],
        summary: "Open Parchment for a patient: checks the consult, sends the patient's details, and records the prescribing session",
        body: openParchmentBody,
        response: { 201: openedSessionReply },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new UnauthorizedError();
      const opened = await openParchment(tenantContextOf(request), request.body.patientId, auth.email);
      return reply.code(201).send(opened);
    },
  );
};
