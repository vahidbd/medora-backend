import { randomUUID } from 'node:crypto';
import swagger from '@fastify/swagger';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env, isDeployed, isTest } from './config/env.js';
import { pingDatabase } from './db/health.js';
import { postgresError } from './lib/database-errors.js';
import { REDACT_PATHS, maskText, safeErrorMessage } from './lib/redact.js';
import { createResponseSerializer } from './lib/response-schema.js';
import { registerModules } from './modules/index.js';
import { authPlugin } from './plugins/auth.js';
import { clientIpPlugin } from './plugins/client-ip.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { requestLogPlugin } from './plugins/request-log.js';
import { routeRulesPlugin } from './plugins/route-rules.js';
import { securityHeadersPlugin } from './plugins/security-headers.js';

export type App = FastifyInstance;

const SERVICE = 'medora-api';

const healthReply = z.object({ status: z.literal('ok'), service: z.string(), version: z.string() });
const readyReply = healthReply.extend({ database: z.literal('ok') });
const notReadyReply = z.object({ status: z.literal('unavailable'), service: z.string(), version: z.string(), database: z.literal('unreachable') });

function loggerOptions() {
  if (isTest) return false;
  return {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      err: (error: Error) => {
        const pg = postgresError(error);
        return {
          type: error.name,
          ...(pg ? { code: pg.code, cause: maskText(pg.message) } : {}),
          message: safeErrorMessage(error),
          stack: error.stack ? maskText(error.stack.replace(/\nparams:[^\n]*/, '')) : '',
        };
      },
    },
    ...(env.MEDORA_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } } : {}),
  };
}

export async function buildApp(): Promise<App> {
  const app = Fastify({
    logger: loggerOptions(),
    // plugins/request-log.ts writes one line per request instead, with the route pattern.
    logController: new LogController({ disableRequestLogging: true }),
    // A caller can't choose its own request id: it ends up in the audit log.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(createResponseSerializer({ strict: isTest, log: app.log }));

  await app.register(routeRulesPlugin);
  await app.register(securityHeadersPlugin);
  await app.register(clientIpPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(requestLogPlugin);
  await app.register(authPlugin);
  await app.register(swagger, {
    openapi: {
      info: { title: 'Medora API', version: '1' },
      components: { securitySchemes: { session: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });

  const version = env.RELEASE_SHA ?? 'development';

  // Liveness, and which commit is live (ADR 0024, FND4).
  app.get(
    '/health',
    { config: { access: 'public' }, schema: { tags: ['system'], security: [], response: { 200: healthReply } } },
    async () => ({ status: 'ok' as const, service: SERVICE, version }),
  );

  // Readiness: the database answers. The host only sends traffic to a release that passes this.
  app.get(
    '/health/ready',
    { config: { access: 'public' }, schema: { tags: ['system'], security: [], response: { 200: readyReply, 503: notReadyReply } } },
    async (request, reply) => {
      try {
        await pingDatabase();
        return { status: 'ok' as const, service: SERVICE, version, database: 'ok' as const };
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', service: SERVICE, version, database: 'unreachable' });
      }
    },
  );

  // The contract the web app's types are generated from (ADR 0014). Not served once deployed (ADR 0030).
  if (!isDeployed) {
    app.get('/openapi.json', { config: { access: 'public' }, schema: { hide: true } }, async () => app.swagger());
  }

  await app.register(registerModules, { prefix: '/v1' });
  return app;
}
