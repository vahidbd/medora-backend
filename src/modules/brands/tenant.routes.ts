import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import {
  companiesReply,
  company,
  companyChange,
  companyDeletedReply,
  companyInput,
  companyParams,
  onboardingReply,
  tenantSettings,
  tenantSettingsChange,
} from './brands.schemas.js';
import { changeCompany, changeSettings, createCompany, deleteCompany, getSettings, listCompanies, onboarding } from './tenant.service.js';

const NO_AGENT = { none: "A tenant's set-up is done by its people (docs/decisions/admin.md ADM18)" } as const;

export const tenantRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/tenant',
    {
      config: { access: 'member' },
      schema: { tags: ['tenant'], summary: "The tenant's name and time zone", response: { 200: tenantSettings } },
    },
    async (request) => withTenant(tenantContextOf(request), getSettings),
  );

  app.patch(
    '/tenant',
    {
      config: { access: { permission: 'tenant:manage' }, audit: ['tenant.changed'], events: ['tenant.changed'], agentTool: NO_AGENT },
      schema: { tags: ['tenant'], summary: "Change the tenant's name or time zone", body: tenantSettingsChange, response: { 200: tenantSettings } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeSettings(tx, request.body)),
  );

  app.get(
    '/tenant/onboarding',
    {
      config: { access: 'member' },
      schema: {
        tags: ['tenant'],
        summary: 'What the tenant still needs before it can take new patients',
        response: { 200: onboardingReply },
      },
    },
    async (request) => withTenant(tenantContextOf(request), onboarding),
  );

  app.get(
    '/companies',
    {
      config: { access: 'member' },
      schema: { tags: ['tenant'], summary: "The tenant's companies", response: { 200: companiesReply } },
    },
    async (request) => ({ companies: await withTenant(tenantContextOf(request), listCompanies) }),
  );

  app.post(
    '/companies',
    {
      config: { access: { permission: 'tenant:manage' }, audit: ['company.created'], events: ['company.created'], agentTool: NO_AGENT },
      schema: { tags: ['tenant'], summary: 'Add a company, with its ABN', body: companyInput, response: { 201: company } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createCompany(tx, request.body))),
  );

  app.patch(
    '/companies/:companyId',
    {
      config: { access: { permission: 'tenant:manage' }, audit: ['company.changed'], events: ['company.changed'], agentTool: NO_AGENT },
      schema: { tags: ['tenant'], summary: 'Change a company', params: companyParams, body: companyChange, response: { 200: company } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeCompany(tx, request.params.companyId, request.body)),
  );

  app.delete(
    '/companies/:companyId',
    {
      config: { access: { permission: 'tenant:manage' }, audit: ['company.deleted'], events: ['company.deleted'], agentTool: NO_AGENT },
      schema: { tags: ['tenant'], summary: 'Delete a company with no brands', params: companyParams, response: { 200: companyDeletedReply } },
    },
    async (request) => {
      await withTenant(tenantContextOf(request), (tx) => deleteCompany(tx, request.params.companyId));
      return { companyId: request.params.companyId };
    },
  );
};
