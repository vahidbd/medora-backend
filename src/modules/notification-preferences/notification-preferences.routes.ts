import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { notificationPreferencesSchema } from './notification-preferences.schemas.js';
import { notificationPreferencesOf, setNotificationPreferences } from './notification-preferences.service.js';

/** The signed-in patient's own preferences, under /v1/patient (docs/decisions/notifications.md). */
export const notificationPreferencesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/patient/notification-preferences',
    {
      config: { access: 'patient' },
      schema: { tags: ['notifications'], summary: 'How the signed-in patient wants to hear from their care', response: { 200: notificationPreferencesSchema } },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => notificationPreferencesOf(tx, requirePatient(request).patientId)),
  );

  app.put(
    '/patient/notification-preferences',
    {
      config: {
        access: 'patient',
        audit: ['notification_preferences.changed'],
        events: { none: 'Whatever sends to a patient reads the preferences when it sends' },
        agentTool: { none: 'Only the patient chooses how they hear from their care' },
      },
      schema: { tags: ['notifications'], summary: 'Change how the signed-in patient hears from their care', body: notificationPreferencesSchema, response: { 200: notificationPreferencesSchema } },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => setNotificationPreferences(tx, requirePatient(request).patientId, request.body)),
  );
};
