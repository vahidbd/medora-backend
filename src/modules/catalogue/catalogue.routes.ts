import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withPerson, withTenant } from '../../db/tenant.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { addBlockRule, listBlockRules } from './block-rules.service.js';
import {
  blockRule,
  blockRuleInput,
  blockRulesReply,
  product,
  productBlockInput,
  productChange,
  productInput,
  productParams,
  productsReply,
  productStatusChange,
} from './catalogue.schemas.js';
import {
  blockProduct,
  changeProduct,
  createProduct,
  getProduct,
  listProducts,
  setProductStatus,
  unblockProduct,
} from './catalogue.service.js';

const NO_AGENT = { none: 'People set up the catalogue and its prices; no agent changes them (docs/decisions/catalogue.md CAT5)' } as const;
const PLATFORM_ONLY = { none: 'Only platform staff, as people, add block rules (docs/decisions/catalogue.md CAT2)' } as const;
const read = { permission: 'catalogue:read' } as const;
const manage = { permission: 'catalogue:manage' } as const;

function signedInPerson(request: { auth: { userId: string } | null }): string {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth.userId;
}

export const catalogueRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/products',
    {
      config: { access: read },
      schema: { tags: ['catalogue'], summary: "The tenant's products, each with whether it is blocked now", response: { 200: productsReply } },
    },
    async (request) => ({ products: await withTenant(tenantContextOf(request), listProducts) }),
  );

  app.get(
    '/products/:productId',
    {
      config: { access: read },
      schema: { tags: ['catalogue'], summary: 'One product', params: productParams, response: { 200: product } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getProduct(tx, request.params.productId)),
  );

  app.post(
    '/products',
    {
      config: { access: manage, audit: ['product.created'], events: ['product.created'], agentTool: NO_AGENT },
      schema: { tags: ['catalogue'], summary: 'Add a product', body: productInput, response: { 201: product } },
    },
    async (request, reply) => reply.code(201).send(await withTenant(tenantContextOf(request), (tx) => createProduct(tx, request.body))),
  );

  app.patch(
    '/products/:productId',
    {
      config: { access: manage, audit: ['product.changed'], events: ['product.changed'], agentTool: NO_AGENT },
      schema: { tags: ['catalogue'], summary: 'Change a product or its price', params: productParams, body: productChange, response: { 200: product } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => changeProduct(tx, request.params.productId, request.body)),
  );

  app.post(
    '/products/:productId/status',
    {
      config: { access: manage, audit: ['product.status_changed'], events: ['product.status_changed'], agentTool: NO_AGENT },
      schema: {
        tags: ['catalogue'],
        summary: 'Archive a product, or bring it back',
        params: productParams,
        body: productStatusChange,
        response: { 200: product },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => setProductStatus(tx, request.params.productId, request.body.status)),
  );

  app.post(
    '/products/:productId/block',
    {
      config: { access: manage, audit: ['product.blocked'], events: ['product.blocked'], agentTool: NO_AGENT },
      schema: {
        tags: ['catalogue'],
        summary: "Block a product in this tenant, with the reason",
        params: productParams,
        body: productBlockInput,
        response: { 200: product },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => blockProduct(tx, request.params.productId, request.body.reason)),
  );

  app.delete(
    '/products/:productId/block',
    {
      config: { access: manage, audit: ['product.unblocked'], events: ['product.unblocked'], agentTool: NO_AGENT },
      schema: {
        tags: ['catalogue'],
        summary: "Lift this tenant's block. Medora's block rules still apply.",
        params: productParams,
        response: { 200: product },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => unblockProduct(tx, request.params.productId)),
  );

  app.get(
    '/block-rules',
    {
      config: { access: 'signed-in' },
      schema: { tags: ['catalogue'], summary: "Medora's block rules, in force or announced, the same for every tenant", response: { 200: blockRulesReply } },
    },
    async (request) => ({ rules: await withPerson(signedInPerson(request), listBlockRules) }),
  );

  app.post(
    '/platform/block-rules',
    {
      config: { access: 'platform', audit: ['block_rule.added'], events: { none: 'A block rule belongs to no tenant; each tenant sees it on its products at once (CAT3)' }, agentTool: PLATFORM_ONLY },
      schema: { tags: ['platform'], summary: 'Add a block rule for every tenant', body: blockRuleInput, response: { 201: blockRule } },
    },
    async (request, reply) =>
      reply.code(201).send(await withPerson(signedInPerson(request), (tx) => addBlockRule(tx, request.body, request.id))),
  );
};
