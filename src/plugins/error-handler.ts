import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { databaseRefusal } from '../lib/database-errors.js';
import { AppError, TooManyRequestsError } from '../lib/errors.js';
import { reportError } from '../lib/error-tracking.js';

/**
 * One error envelope for every failure: { error: { code, message, details? } }.
 * AppErrors map to their status; schema validation to 400 with the fields; a
 * database refusal to plain words (ADR 0028); anything else is a 500 with
 * nothing internal in it, logged and reported (ADR 0026).
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      if (error instanceof TooManyRequestsError) reply.header('retry-after', String(error.retryAfterSeconds));
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: 'bad_request',
          message: 'Some of what was sent is missing or not in the right form',
          details: error.validation.map((issue) => ({ path: issue.instancePath, message: issue.message })),
        },
      });
    }

    const report = (message: string) => {
      request.log.error({ err: error, route: request.routeOptions.url }, message);
      reportError(error, {
        tags: { route: request.routeOptions.url ?? 'unmatched', method: request.method, request_id: request.id, tenant: request.auth?.tenant?.tenantId },
        ...(request.auth ? { userId: request.auth.userId } : {}),
      });
    };

    const refusal = databaseRefusal(error);
    if (refusal) {
      report('database refused a write');
      return reply.status(refusal.status).send({ error: { code: refusal.code, message: refusal.message } });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      report('unhandled error');
      return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side' } });
    }
    return reply.status(statusCode).send({ error: { code: 'request_error', message: error.message } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'There is nothing at this address' } });
  });
});
