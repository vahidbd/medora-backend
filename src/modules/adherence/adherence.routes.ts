import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { recordAppOpened } from './activity.service.js';
import { appOpenedReply } from './adherence.schemas.js';
import { adherenceReviewRoutes } from './review.routes.js';

/** The patient's side of the adherence activity stream (docs/decisions/adherence.md ADH2), and the care team's adherence flags. */
export const adherenceRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(adherenceReviewRoutes);
  app.post(
    '/patient/activity/app-opened',
    {
      config: {
        access: 'patient',
        audit: ['adherence_activity.recorded', 'patient.read'],
        events: { none: 'Opening the app is activity for the rules, read in place; nothing else reacts to it (ADR 0260)' },
        agentTool: { none: 'Only the patient opens their app; an agent never acts as a patient (ADR 0012)' },
      },
      schema: {
        tags: ['adherence'],
        summary: 'The signed-in patient opened their app: counted once on each of their calendar days',
        response: { 200: appOpenedReply },
      },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => recordAppOpened(tx, requirePatient(request).patientId)),
  );
};
