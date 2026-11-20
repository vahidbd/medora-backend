import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Security headers on every reply (ADR 0030). The API serves JSON only, so
 * its content security policy allows nothing, and no reply may be cached:
 * replies can hold health data. No CORS headers are sent at all
 * (docs/decisions/foundation.md FND5): browsers reach the API only through
 * the web app's server.
 */
export const securityHeadersPlugin = fp(async (app: FastifyInstance) => {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    hsts: { maxAge: 63_072_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
});
