import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { TooManyRequestsError } from '../../lib/errors.js';
import { countAttempt, type Limit } from '../../lib/rate-limit.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import { auditExport, auditFilter, auditPage, auditQuery } from './audit.schemas.js';
import { exportAudit, searchAudit } from './audit.service.js';

/** ADM26: ten exports an hour for each person in each tenant. */
export const AUDIT_EXPORT_LIMIT: Limit = { name: 'audit-export', max: 10, windowSeconds: 3600 };

const read = { permission: 'audit:read' } as const;

export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/audit',
    {
      config: { access: read },
      schema: { tags: ['audit'], summary: "The tenant's audit log, newest first", querystring: auditQuery, response: { 200: auditPage } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => searchAudit(tx, request.query)),
  );

  app.post(
    '/audit/exports',
    {
      config: {
        access: read,
        audit: ['audit.exported'],
        events: { none: 'An export is a read; its audit entry records who took what' },
        agentTool: { none: 'People export the audit log; no agent reads it (docs/decisions/admin.md ADM26)' },
      },
      schema: {
        tags: ['audit'],
        summary: 'Every entry a filter matches, up to 5,000, recorded as an export',
        body: auditFilter,
        response: { 200: auditExport },
      },
    },
    async (request) => {
      const { auth, tenant } = requireTenant(request);
      const attempt = await countAttempt(AUDIT_EXPORT_LIMIT, `${tenant.tenantId}:${auth.userId}`);
      if (attempt.count > AUDIT_EXPORT_LIMIT.max) throw new TooManyRequestsError(attempt.retryAfterSeconds);
      return withTenant(tenantContextOf(request), (tx) => exportAudit(tx, request.body));
    },
  );
};
