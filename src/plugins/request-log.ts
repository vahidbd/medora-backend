import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * One log line per request, written when the reply has gone (ADR 0026):
 *
 *   {"route":"/v1/staff/:membershipId","method":"PATCH","status":200,"ms":38,"tenant":"…","user":"…","msg":"request"}
 *
 * The route is the pattern, never the address as typed, and there is no
 * query string: searches carry names. Fastify's own request logging is off.
 * Health checks are left out while they pass.
 */
const QUIET_ROUTES = new Set(['/health', '/health/ready']);

export interface RequestLogLine {
  method: string;
  route: string;
  status: number;
  ms: number;
  tenant?: string;
  user?: string;
}

export function requestLogLine(request: FastifyRequest, reply: FastifyReply): RequestLogLine {
  return {
    method: request.method,
    route: request.routeOptions.url ?? 'unmatched',
    status: reply.statusCode,
    ms: Math.round(reply.elapsedTime),
    ...(request.auth?.tenant ? { tenant: request.auth.tenant.tenantId } : {}),
    ...(request.auth ? { user: request.auth.userId } : {}),
  };
}

export const requestLogPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onResponse', async (request, reply) => {
    const line = requestLogLine(request, reply);
    if (QUIET_ROUTES.has(line.route) && line.status < 500) return;
    if (line.status >= 500) request.log.error(line, 'request');
    else request.log.info(line, 'request');
  });
});
