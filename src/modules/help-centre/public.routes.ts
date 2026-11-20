import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { withPublic, withTenant, type TenantContext } from '../../db/tenant.js';
import { NotFoundError, TooManyRequestsError } from '../../lib/errors.js';
import { countAttempt, type Limit } from '../../lib/rate-limit.js';
import { normaliseHost, resolvePublicBrand } from '../brands/index.js';
import { hostParams, publicArticleParams, publicArticleReply, publicHelpCentreReply, publicSearchQuery, publicSearchReply } from './help-centre.schemas.js';
import { publicArticle, publicHelpCentre, publicSearch } from './published.service.js';

/**
 * A brand's public help centre (docs/decisions/support.md SUP17), read by the
 * host its site is served on: a live or paused brand with a verified domain.
 * No sign-in, no tracking, published wording only. Searches are never cached
 * or logged, since people type health details into search boxes.
 */

export const HELP_CENTRE_LIMIT: Limit = { name: 'help-centre', max: 120, windowSeconds: 60 };

async function brandAt(request: FastifyRequest, typedHost: string): Promise<{ context: TenantContext; brandId: string }> {
  const { count, retryAfterSeconds } = await countAttempt(HELP_CENTRE_LIMIT, request.clientIp);
  if (count > HELP_CENTRE_LIMIT.max) throw new TooManyRequestsError(retryAfterSeconds);
  const host = normaliseHost(typedHost);
  const resolved = host ? await withPublic((tx) => resolvePublicBrand(tx, { host })) : null;
  if (!resolved) throw new NotFoundError('Help centre');
  return { context: { tenantId: resolved.tenantId, actor: { type: 'system' }, requestId: request.id }, brandId: resolved.brandId };
}

export const publicHelpCentreRoutes: FastifyPluginAsyncZod = async (app) => {
  const tags = ['public'];

  app.get(
    '/public/help-centre/:host',
    {
      config: { access: 'public' },
      schema: { tags, summary: "A brand's help centre: its sections and published articles", params: hostParams, response: { 200: publicHelpCentreReply } },
    },
    async (request, reply) => {
      const { context, brandId } = await brandAt(request, request.params.host);
      void reply.header('cache-control', 'public, max-age=60');
      return withTenant(context, (tx) => publicHelpCentre(tx, brandId));
    },
  );

  app.get(
    '/public/help-centre/:host/search',
    {
      config: { access: 'public' },
      schema: { tags, summary: "Search a brand's published help centre articles", params: hostParams, querystring: publicSearchQuery, response: { 200: publicSearchReply } },
    },
    async (request, reply) => {
      const { context, brandId } = await brandAt(request, request.params.host);
      void reply.header('cache-control', 'no-store');
      return withTenant(context, (tx) => publicSearch(tx, brandId, request.query.q));
    },
  );

  app.get(
    '/public/help-centre/:host/articles/:slug',
    {
      config: { access: 'public' },
      schema: { tags, summary: 'One published help centre article', params: publicArticleParams, response: { 200: publicArticleReply } },
    },
    async (request, reply) => {
      const { context, brandId } = await brandAt(request, request.params.host);
      void reply.header('cache-control', 'public, max-age=60');
      return withTenant(context, (tx) => publicArticle(tx, brandId, request.params.slug));
    },
  );
};
