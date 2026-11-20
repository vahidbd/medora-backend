import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { createPriceBody, price, priceDetails, priceParams, pricesQuery, pricesReply, publishPriceBody } from './prices.schemas.js';
import { createPrice, getPrice, listPrices, publishPrice, retirePrice, revisePrice, updateDraftPrice } from './prices.service.js';

/** What patients are charged is a person's decision (ADR 0012); agents read prices through the patient's own invoices. */
const NO_AGENT = { none: 'What patients are charged is decided by a person (ADR 0012)' };
const access = { permission: 'prices:manage' } as const;
const tags = ['billing'];

export const priceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/prices',
    { config: { access }, schema: { tags, summary: "The tenant's prices, every version, with their fees", querystring: pricesQuery, response: { 200: pricesReply } } },
    async (request) => ({ prices: await withTenant(tenantContextOf(request), (tx) => listPrices(tx, request.query)) }),
  );

  app.get(
    '/prices/:priceId',
    { config: { access }, schema: { tags, summary: 'One price and its fees', params: priceParams, response: { 200: price } } },
    async (request) => withTenant(tenantContextOf(request), (tx) => getPrice(tx, request.params.priceId)),
  );

  app.post(
    '/prices',
    {
      config: { access, audit: ['price.created'], events: ['price.created'], agentTool: NO_AGENT },
      schema: { tags, summary: 'Add a draft price for a program', body: createPriceBody, response: { 201: price } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createPrice(tx, request.body))),
  );

  app.put(
    '/prices/:priceId',
    {
      config: { access, audit: ['price.updated'], events: { none: 'A draft is seen only by the staff editing it' }, agentTool: NO_AGENT },
      schema: { tags, summary: "Replace a draft price's details and fees", params: priceParams, body: priceDetails, response: { 200: price } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => updateDraftPrice(tx, request.params.priceId, request.body)),
  );

  app.post(
    '/prices/:priceId/publish',
    {
      config: { access, audit: ['price.published', 'price.retired'], events: ['price.published', 'price.retired'], agentTool: NO_AGENT },
      schema: {
        tags,
        summary: 'Make a draft price live, retiring the version it replaces',
        params: priceParams,
        body: publishPriceBody,
        response: { 200: price },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => publishPrice(tx, request.params.priceId)),
  );

  app.post(
    '/prices/:priceId/revisions',
    {
      config: { access, audit: ['price.created'], events: ['price.created'], agentTool: NO_AGENT },
      schema: { tags, summary: 'Start a new version of a live price, as a draft', params: priceParams, response: { 201: price } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => revisePrice(tx, request.params.priceId))),
  );

  app.post(
    '/prices/:priceId/retire',
    {
      config: { access, audit: ['price.retired'], events: ['price.retired'], agentTool: NO_AGENT },
      schema: { tags, summary: 'Stop offering a live price to new patients. Its subscriptions keep it', params: priceParams, response: { 200: price } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => retirePrice(tx, request.params.priceId)),
  );
};
