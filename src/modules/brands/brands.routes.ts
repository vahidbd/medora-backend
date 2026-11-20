import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import {
  brand,
  brandChange,
  brandInput,
  brandParams,
  brandsReply,
  brandStatusChange,
  domainDeletedReply,
  domainInput,
  domainParams,
} from './brands.schemas.js';
import { addDomain, changeBrand, createBrand, getBrand, listBrands, removeDomain, setBrandStatus } from './brands.service.js';

const NO_AGENT = { none: "A brand's set-up and going live are done by people (docs/decisions/admin.md ADM16)" } as const;
const manage = { permission: 'brands:manage' } as const;

export const brandRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/brands',
    {
      config: { access: 'member' },
      schema: { tags: ['brands'], summary: "The tenant's brands and their domains", response: { 200: brandsReply } },
    },
    async (request) => ({ brands: await withTenant(tenantContextOf(request), listBrands) }),
  );

  app.get(
    '/brands/:brandId',
    {
      config: { access: 'member' },
      schema: { tags: ['brands'], summary: 'One brand', params: brandParams, response: { 200: brand } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getBrand(tx, request.params.brandId)),
  );

  app.post(
    '/brands',
    {
      config: { access: manage, audit: ['brand.created'], events: ['brand.created'], agentTool: NO_AGENT },
      schema: { tags: ['brands'], summary: 'Add a brand, as a draft', body: brandInput, response: { 201: brand } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createBrand(tx, request.body))),
  );

  app.patch(
    '/brands/:brandId',
    {
      config: { access: manage, audit: ['brand.changed'], events: ['brand.changed'], agentTool: NO_AGENT },
      schema: { tags: ['brands'], summary: 'Change a brand', params: brandParams, body: brandChange, response: { 200: brand } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeBrand(tx, request.params.brandId, request.body)),
  );

  app.post(
    '/brands/:brandId/status',
    {
      config: { access: manage, audit: ['brand.status_changed'], events: ['brand.status_changed'], agentTool: NO_AGENT },
      schema: {
        tags: ['brands'],
        summary: 'Go live, pause new sign-ups, or resume',
        params: brandParams,
        body: brandStatusChange,
        response: { 200: brand },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => setBrandStatus(tx, request.params.brandId, request.body.status)),
  );

  app.post(
    '/brands/:brandId/domains',
    {
      config: { access: manage, audit: ['brand_domain.added'], events: ['brand_domain.added'], agentTool: NO_AGENT },
      schema: {
        tags: ['brands'],
        summary: 'Add a domain, for Medora to verify',
        params: brandParams,
        body: domainInput,
        response: { 201: brand },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => addDomain(tx, request.params.brandId, request.body.host))),
  );

  app.delete(
    '/brands/:brandId/domains/:domainId',
    {
      config: { access: manage, audit: ['brand_domain.removed'], events: ['brand_domain.removed'], agentTool: NO_AGENT },
      schema: { tags: ['brands'], summary: 'Remove a domain', params: domainParams, response: { 200: domainDeletedReply } },
    },
    async (request) => {
      await withTenant(tenantContextOf(request), (tx) => removeDomain(tx, request.params.brandId, request.params.domainId));
      return { domainId: request.params.domainId };
    },
  );
};
