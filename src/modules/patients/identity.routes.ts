import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { checkIdentityDocument, correctLegalDetails, identityState, refreshIhi, reopenIdentityChecks, verifyIdentityManually } from './identity.service.js';
import { identityDocumentBody, identityStateReply, legalDetailsBody, manualIdentityBody, patientParams, reasonBody } from './patients.schemas.js';

/** Identity checks and the IHI (docs/decisions/patients.md IDN16 to IDN19). */

const PEOPLE_ONLY = { none: 'Checking who a patient is, and correcting it, is done by the patient or a staff member; an agent never does it (ADR 0012)' };

export const identityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/patient/identity',
    {
      config: { access: 'patient' },
      schema: { tags: ['patients'], summary: 'Where the signed-in patient’s identity check stands', response: { 200: identityStateReply } },
    },
    async (request) => withTenant(patientContextOf(request), (tx) => identityState(tx, requirePatient(request).patientId)),
  );

  app.post(
    '/patient/identity-check',
    {
      config: {
        access: 'patient',
        audit: ['patient.identity_checked', 'patient.ihi_looked_up', 'patient.identity_read'],
        events: ['patient.identity_verified', 'patient.identity_failed'],
        agentTool: PEOPLE_ONLY,
      },
      schema: { tags: ['patients'], summary: 'Check the signed-in patient’s identity against one document', body: identityDocumentBody, response: { 200: identityStateReply } },
    },
    async (request) => checkIdentityDocument(patientContextOf(request), requirePatient(request).patientId, request.body),
  );

  app.get(
    '/patients/:patientId/identity',
    {
      config: { access: { permission: 'patients:read' } },
      schema: { tags: ['patients'], summary: 'A patient’s identity checks and IHI status', params: patientParams, response: { 200: identityStateReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => identityState(tx, request.params.patientId)),
  );

  app.post(
    '/patients/:patientId/identity/manual',
    {
      config: {
        access: { permission: 'patients:verify_identity' },
        audit: ['patient.identity_checked', 'patient.ihi_looked_up', 'patient.identity_read'],
        events: ['patient.identity_verified'],
        agentTool: PEOPLE_ONLY,
      },
      schema: {
        tags: ['patients'],
        summary: 'Record that a staff member sighted the patient’s identity document',
        params: patientParams,
        body: manualIdentityBody,
        response: { 200: identityStateReply },
      },
    },
    async (request) => verifyIdentityManually(tenantContextOf(request), request.params.patientId, request.body),
  );

  app.post(
    '/patients/:patientId/identity/reopen',
    {
      config: { access: { permission: 'patients:manage' }, audit: ['patient.identity_reopened', 'patient.identity_read'], events: { none: 'Nothing else reacts until the patient checks again' }, agentTool: PEOPLE_ONLY },
      schema: { tags: ['patients'], summary: 'Let a patient whose online checks didn’t match try again', params: patientParams, body: reasonBody, response: { 200: identityStateReply } },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        await reopenIdentityChecks(tx, request.params.patientId, request.body.reason);
        return identityState(tx, request.params.patientId);
      }),
  );

  app.post(
    '/patients/:patientId/legal-details',
    {
      config: { access: { permission: 'patients:manage' }, audit: ['patient.legal_details_corrected', 'patient.identity_read'], events: ['patient.updated'], agentTool: PEOPLE_ONLY },
      schema: {
        tags: ['patients'],
        summary: 'Correct a patient’s legal name, date of birth or sex, which needs a new identity check',
        params: patientParams,
        body: legalDetailsBody,
        response: { 200: identityStateReply },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        const { reason, ...change } = request.body;
        await correctLegalDetails(tx, request.params.patientId, change, reason);
        return identityState(tx, request.params.patientId);
      }),
  );

  app.post(
    '/patients/:patientId/ihi-lookup',
    {
      config: { access: { permission: 'patients:manage' }, audit: ['patient.ihi_looked_up', 'patient.identity_read'], events: { none: 'Prescribing reads the IHI when it prescribes' }, agentTool: PEOPLE_ONLY },
      schema: { tags: ['patients'], summary: 'Look up a verified patient’s IHI again', params: patientParams, response: { 200: identityStateReply } },
    },
    async (request) => {
      const context = tenantContextOf(request);
      if ((await refreshIhi(context, request.params.patientId)) === 'not_verified') {
        throw new BusinessRuleError('Verify the patient’s identity before looking up their IHI', 'identity_not_verified');
      }
      return withTenant(context, (tx) => identityState(tx, request.params.patientId));
    },
  );
};
