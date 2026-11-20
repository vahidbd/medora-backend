import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { adherenceFlagDetail, adherenceFlagListQuery, adherenceFlagListReply, adherenceFlagParams, resolveAdherenceFlagBody } from './adherence.schemas.js';
import { getAdherenceFlag, listAdherenceFlags, reopenAdherenceFlag, resolveAdherenceFlag } from './review.service.js';

/**
 * The care team's adherence flags (docs/decisions/adherence.md ADH7 to
 * ADH10). Clinical-zone permissions, so only a clinical role, or someone
 * under break-glass, gets here (ADR 0220).
 */

const PEOPLE_ONLY = { none: 'Resolving or reopening an adherence flag is a clinical escalation, which only people do (ADR 0260, ADH8)' };

export const adherenceReviewRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/adherence/flags',
    {
      config: { access: { permission: 'adherence:read' } },
      schema: {
        tags: ['adherence'],
        summary: 'The tenant’s adherence flags: open ones urgent first, then oldest; resolved ones newest first',
        querystring: adherenceFlagListQuery,
        response: { 200: adherenceFlagListReply },
      },
    },
    async (request) => ({ adherenceFlags: await withTenant(tenantContextOf(request), (tx) => listAdherenceFlags(tx, request.query)) }),
  );

  app.get(
    '/adherence/flags/:adherenceFlagId',
    {
      config: { access: { permission: 'adherence:read' } },
      schema: { tags: ['adherence'], summary: 'An adherence flag, with its resolution and the one it reopens', params: adherenceFlagParams, response: { 200: adherenceFlagDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getAdherenceFlag(tx, request.params.adherenceFlagId)),
  );

  app.post(
    '/adherence/flags/:adherenceFlagId/resolve',
    {
      config: { access: { permission: 'adherence:resolve' }, audit: ['adherence_flag.resolved', 'adherence_flag.read'], events: ['adherence_flag.resolved'], agentTool: PEOPLE_ONLY },
      schema: { tags: ['adherence'], summary: 'Resolve an open adherence flag with what was done', params: adherenceFlagParams, body: resolveAdherenceFlagBody, response: { 200: adherenceFlagDetail } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => resolveAdherenceFlag(tx, request.params.adherenceFlagId, request.body)),
  );

  app.post(
    '/adherence/flags/:adherenceFlagId/reopen',
    {
      config: { access: { permission: 'adherence:resolve' }, audit: ['adherence_flag.reopened', 'adherence_flag.read'], events: ['adherence_flag.reopened'], agentTool: PEOPLE_ONLY },
      schema: {
        tags: ['adherence'],
        summary: 'Undo a mistaken resolution: a new open adherence flag for the same cause, linked to the resolved one',
        params: adherenceFlagParams,
        response: { 201: adherenceFlagDetail },
      },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => reopenAdherenceFlag(tx, request.params.adherenceFlagId))),
  );
};
