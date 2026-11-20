import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withPerson, withPublic, withTenant } from '../../db/tenant.js';
import { NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { invitations } from '../staff/index.js';
import {
  domainVerifiedReply,
  hostParams,
  ownerInvitationReply,
  platformDomainParams,
  platformDomainsQuery,
  platformDomainsReply,
  platformTenantParams,
  platformTenantsReply,
  publicBrand,
  tenantCreatedReply,
  tenantInput,
} from './brands.schemas.js';
import { publicBrand as findPublicBrand } from './brands.service.js';
import { normaliseHost } from './checks.js';
import { createTenant, platformDomains, platformTenants, renewOwnerInvitation, resolvePublicBrand, verifyDomain } from './platform.service.js';

const NO_AGENT = { none: 'Only platform staff, as people, create tenants and verify domains (docs/decisions/admin.md ADM15)' } as const;

function platformPerson(request: { auth: { userId: string } | null }): string {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth.userId;
}

/** Platform staff's routes (ADM14, ADM15): no tenant header, and only tenant names, brands and domains. */
export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/platform/tenants',
    {
      config: { access: 'platform' },
      schema: { tags: ['platform'], summary: 'Every tenant, by name, and how far it has got', response: { 200: platformTenantsReply } },
    },
    async (request) => ({ tenants: await withPerson(platformPerson(request), platformTenants) }),
  );

  app.post(
    '/platform/tenants',
    {
      config: {
        access: 'platform',
        audit: ['tenant.created', 'membership.invited'],
        events: ['tenant.created', 'membership.invited'],
        agentTool: NO_AGENT,
      },
      schema: { tags: ['platform'], summary: 'Create a tenant and invite its first owner', body: tenantInput, response: { 201: tenantCreatedReply } },
    },
    async (request, reply) => {
      const created = await withPerson(platformPerson(request), (tx) => createTenant(tx, request.body, request.id));
      // ADR 0029: the email goes out after the tenant and the invitation have committed.
      const email = await invitations.send(created.ownerEmail);
      return reply.code(201).send({ tenant: created.tenant, email });
    },
  );

  app.post(
    '/platform/tenants/:tenantId/owner-invitation',
    {
      config: {
        access: 'platform',
        audit: ['membership.invitation_resent'],
        events: ['membership.invitation_resent'],
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['platform'],
        summary: "Send the first owner's invitation again, while nobody has accepted it",
        params: platformTenantParams,
        response: { 200: ownerInvitationReply },
      },
    },
    async (request) => {
      const { tenantId } = request.params;
      const ownerEmail = await withPerson(platformPerson(request), (tx) => renewOwnerInvitation(tx, tenantId, request.id));
      return { tenantId, email: await invitations.send(ownerEmail) };
    },
  );

  app.get(
    '/platform/domains',
    {
      config: { access: 'platform' },
      schema: {
        tags: ['platform'],
        summary: "Brands' domains: those waiting for a check, or all",
        querystring: platformDomainsQuery,
        response: { 200: platformDomainsReply },
      },
    },
    async (request) => ({
      domains: await withPerson(platformPerson(request), (tx) => platformDomains(tx, request.query.waiting === 'true')),
    }),
  );

  app.post(
    '/platform/domains/:domainId/verify',
    {
      config: { access: 'platform', audit: ['brand_domain.verified'], events: ['brand_domain.verified'], agentTool: NO_AGENT },
      schema: {
        tags: ['platform'],
        summary: "Mark a domain verified once its DNS points at Medora",
        params: platformDomainParams,
        response: { 200: domainVerifiedReply },
      },
    },
    async (request) => withPerson(platformPerson(request), (tx) => verifyDomain(tx, request.params.domainId, request.id)),
  );

  app.get(
    '/public/brands/by-host/:host',
    {
      config: { access: 'public' },
      schema: {
        tags: ['public'],
        summary: 'The live or paused brand a verified domain belongs to, for its public pages',
        params: hostParams,
        response: { 200: publicBrand },
      },
    },
    async (request, reply) => {
      const host = normaliseHost(request.params.host);
      const resolved = host ? await withPublic((tx) => resolvePublicBrand(tx, { host })) : null;
      const found = resolved
        ? await withTenant({ tenantId: resolved.tenantId, actor: { type: 'system' }, requestId: request.id }, (tx) =>
            findPublicBrand(tx, resolved.brandId),
          )
        : null;
      if (!found) throw new NotFoundError('Brand');
      void reply.header('cache-control', 'public, max-age=60');
      return found;
    },
  );
};
