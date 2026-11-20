import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import { breakGlassListReply, breakGlassParams, breakGlassQuery, breakGlassRecord, openBody, reviewBody } from './break-glass.schemas.js';
import { closeMyBreakGlass, listBreakGlass, openBreakGlass, reviewBreakGlass } from './break-glass.service.js';

const NO_AGENT = { none: 'Break-glass is a person stating why they need clinical access (docs/decisions/admin.md ADM3); an agent never opens or reviews it' } as const;

export const breakGlassRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/break-glass',
    {
      // No permission of its own: whether it is allowed is the role's clinical permissions (ADM3).
      config: { access: 'member', audit: ['break_glass.opened'], events: ['break_glass.opened'], agentTool: NO_AGENT },
      schema: { tags: ['staff'], summary: 'Open break-glass for 60 minutes, with a reason', body: openBody, response: { 201: breakGlassRecord } },
    },
    async (request, reply) => {
      const { tenant } = requireTenant(request);
      const record = await withTenant(tenantContextOf(request), (tx) => openBreakGlass(tx, tenant, request.body.reason));
      return reply.code(201).send(record);
    },
  );

  app.post(
    '/break-glass/close',
    {
      config: { access: 'member', audit: ['break_glass.closed'], events: ['break_glass.closed'], agentTool: NO_AGENT },
      schema: { tags: ['staff'], summary: 'End your break-glass early', response: { 200: breakGlassListReply } },
    },
    async (request) => {
      const { tenant } = requireTenant(request);
      return { breakGlass: await withTenant(tenantContextOf(request), (tx) => closeMyBreakGlass(tx, tenant)) };
    },
  );

  app.get(
    '/break-glass',
    {
      config: { access: { permission: 'break_glass:review' } },
      schema: { tags: ['staff'], summary: 'Break-glass to review', querystring: breakGlassQuery, response: { 200: breakGlassListReply } },
    },
    async (request) => ({
      breakGlass: await withTenant(tenantContextOf(request), (tx) => listBreakGlass(tx, { unreviewedOnly: request.query.unreviewed === 'true' })),
    }),
  );

  app.post(
    '/break-glass/:breakGlassId/review',
    {
      config: { access: { permission: 'break_glass:review' }, audit: ['break_glass.reviewed'], events: ['break_glass.reviewed'], agentTool: NO_AGENT },
      schema: { tags: ['staff'], summary: 'Mark a break-glass reviewed', params: breakGlassParams, body: reviewBody, response: { 200: breakGlassRecord } },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) => reviewBreakGlass(tx, request.params.breakGlassId, request.body.note)),
  );
};
