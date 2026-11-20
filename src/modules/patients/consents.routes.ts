import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import { patientContextOf, requirePatient } from '../../plugins/patient-auth.js';
import { patientParams } from './patients.schemas.js';
import { consentDocument, consentDocumentsReply, consentStatesReply, giveConsentBody, publishConsentBody, recordConsentBody } from './consents.schemas.js';
import { consentStates, listConsentDocuments, publishConsentDocument, recordConsent } from './consents.service.js';

/** Consent documents and patients' consents (docs/decisions/patients.md IDN12 to IDN14). */

const PEOPLE_ONLY = { none: 'Consent is given by the patient, and its text is published by a person; an agent never does either (ADR 0012)' };

export const consentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/consent-documents',
    {
      config: { access: { permission: 'patients:read' } },
      schema: { tags: ['consents'], summary: 'Every published version of the tenant’s consent documents', response: { 200: consentDocumentsReply } },
    },
    async (request) => ({ documents: await withTenant(tenantContextOf(request), listConsentDocuments) }),
  );

  app.post(
    '/consent-documents',
    {
      config: { access: { permission: 'consents:manage' }, audit: ['consent_document.published'], events: ['consent_document.published'], agentTool: PEOPLE_ONLY },
      schema: { tags: ['consents'], summary: 'Publish a new version of a consent document', body: publishConsentBody, response: { 201: consentDocument } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => publishConsentDocument(tx, request.body))),
  );

  app.get(
    '/patients/:patientId/consents',
    {
      config: { access: { permission: 'patients:read' } },
      schema: { tags: ['consents'], summary: 'A patient’s consents', params: patientParams, response: { 200: consentStatesReply } },
    },
    async (request) => ({ consents: await withTenant(tenantContextOf(request), (tx) => consentStates(tx, request.params.patientId)) }),
  );

  app.post(
    '/patients/:patientId/consents',
    {
      config: { access: { permission: 'patients:manage' }, audit: ['consent.given', 'consent.withdrawn'], events: ['consent.given', 'consent.withdrawn'], agentTool: PEOPLE_ONLY },
      schema: {
        tags: ['consents'],
        summary: 'Record a consent decision a patient made by phone or in person',
        params: patientParams,
        body: recordConsentBody,
        response: { 200: consentStatesReply },
      },
    },
    async (request) => {
      const { auth } = requireTenant(request);
      const { reason, ...decision } = request.body;
      const consents = await withTenant(tenantContextOf(request), (tx) =>
        recordConsent(tx, request.params.patientId, { ...decision, recordedBy: { userId: auth.userId, reason } }),
      );
      return { consents };
    },
  );

  app.get(
    '/patient/consents',
    {
      config: { access: 'patient' },
      schema: { tags: ['consents'], summary: 'The signed-in patient’s consents, with the current text of each', response: { 200: consentStatesReply } },
    },
    async (request) => ({ consents: await withTenant(patientContextOf(request), (tx) => consentStates(tx, requirePatient(request).patientId)) }),
  );

  app.post(
    '/patient/consents',
    {
      config: { access: 'patient', audit: ['consent.given'], events: ['consent.given'], agentTool: PEOPLE_ONLY },
      schema: { tags: ['consents'], summary: 'Agree to the current version of a consent document', body: giveConsentBody, response: { 200: consentStatesReply } },
    },
    async (request) => {
      const { patientId } = requirePatient(request);
      const consents = await withTenant(patientContextOf(request), (tx) =>
        recordConsent(tx, patientId, { documentId: request.body.documentId, decision: 'given', channel: 'web' }),
      );
      return { consents };
    },
  );
};
