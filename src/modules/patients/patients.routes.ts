import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { NotFoundError } from '../../lib/errors.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { patientListQuery, patientListReply, patientParams, patientProfile } from './patients.schemas.js';
import { getPatientProfile, listPatients } from './patients.service.js';

/** Staff reading patients' identity records (docs/decisions/patients.md IDN9). The chart is the clinical record module's. */
export const patientsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/patients',
    {
      config: { access: { permission: 'patients:read' } },
      schema: { tags: ['patients'], summary: "The tenant's patients, newest first or matching a search", querystring: patientListQuery, response: { 200: patientListReply } },
    },
    async (request) => ({ patients: await withTenant(tenantContextOf(request), (tx) => listPatients(tx, request.query)) }),
  );

  app.get(
    '/patients/:patientId',
    {
      config: { access: { permission: 'patients:read' } },
      schema: { tags: ['patients'], summary: "A patient's identity and contact details", params: patientParams, response: { 200: patientProfile } },
    },
    async (request) => {
      const profile = await withTenant(tenantContextOf(request), (tx) => getPatientProfile(tx, request.params.patientId));
      if (!profile) throw new NotFoundError('Patient');
      return profile;
    },
  );
};
