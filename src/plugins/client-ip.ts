import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { env, isDeployed } from '../config/env.js';
import { clientIpOf, type ClientIpOptions } from '../lib/client-ip.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The caller's address as far as it can be trusted (src/lib/client-ip.ts). Never request.ip. */
    readonly clientIp: string;
  }
}

const memo = Symbol('clientIp');
type Memo = FastifyRequest & { [memo]?: string };

export const clientIpPlugin = fp(async (app: FastifyInstance) => {
  const options: ClientIpOptions = {
    secret: env.FORWARDED_IP_SECRET ?? null,
    edgeHeader: env.CLIENT_IP_HEADER?.toLowerCase() ?? (isDeployed ? 'x-real-ip' : null),
  };
  app.decorateRequest('clientIp', {
    getter(this: FastifyRequest) {
      const request = this as Memo;
      return (request[memo] ??= clientIpOf({ headers: request.headers, socket: request.socket }, options));
    },
  });
});
