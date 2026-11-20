import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import {
  changePaymentAccountBody,
  createPaymentAccountBody,
  onboardingLinkReply,
  paymentAccount,
  paymentAccountParams,
  paymentAccountsReply,
} from './payment-accounts.schemas.js';
import {
  changePaymentAccount,
  createPaymentAccount,
  listPaymentAccounts,
  refreshPaymentAccount,
  startOnboarding,
} from './payment-accounts.service.js';

/** Which processor accounts a tenant's patients pay into is a person's decision, never an agent's (ADR 0012). */
const NO_AGENT = { none: "Where a tenant's money goes is decided by a person (ADR 0012)" };
const access = { permission: 'payment_accounts:manage' } as const;

export const paymentAccountRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/payment-accounts',
    {
      config: { access },
      schema: { tags: ['payments'], summary: "The tenant's payment accounts", response: { 200: paymentAccountsReply } },
    },
    async (request) => ({ paymentAccounts: await withTenant(tenantContextOf(request), listPaymentAccounts) }),
  );

  app.post(
    '/payment-accounts',
    {
      config: { access, audit: ['payment_account.created'], events: ['payment_account.created'], agentTool: NO_AGENT },
      schema: {
        tags: ['payments'],
        summary: 'Add a payment account. It takes payments once onboarding on the processor is finished',
        body: createPaymentAccountBody,
        response: { 201: paymentAccount },
      },
    },
    async (request, reply) => {
      const created = await withTenant(tenantContextOf(request), (tx) => createPaymentAccount(tx, request.body));
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/payment-accounts/:paymentAccountId',
    {
      config: {
        access,
        audit: ['payment_account.renamed', 'payment_account.closed', 'payment_account.reopened', 'payment_account.made_default'],
        events: ['payment_account.renamed', 'payment_account.closed', 'payment_account.reopened', 'payment_account.made_default'],
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['payments'],
        summary: 'Rename a payment account, close or reopen it to new subscriptions, or make it the default',
        params: paymentAccountParams,
        body: changePaymentAccountBody,
        response: { 200: paymentAccount },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) => changePaymentAccount(tx, request.params.paymentAccountId, request.body)),
  );

  app.post(
    '/payment-accounts/:paymentAccountId/onboarding-link',
    {
      config: {
        access,
        audit: ['payment_account.onboarding_started', 'payment_account.connected'],
        events: ['payment_account.connected'],
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['payments'],
        summary: "A link to finish setting up the account on the processor's own pages",
        params: paymentAccountParams,
        response: { 200: onboardingLinkReply },
      },
    },
    async (request) => startOnboarding(tenantContextOf(request), request.params.paymentAccountId),
  );

  app.post(
    '/payment-accounts/:paymentAccountId/refresh',
    {
      config: {
        access,
        audit: ['payment_account.processor_state_changed', 'payment_account.activated', 'payment_account.made_default'],
        events: ['payment_account.processor_state_changed', 'payment_account.activated', 'payment_account.made_default'],
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['payments'],
        summary: 'Ask the processor how the account stands now, for when staff come back from its pages',
        params: paymentAccountParams,
        response: { 200: paymentAccount },
      },
    },
    async (request) => refreshPaymentAccount(tenantContextOf(request), request.params.paymentAccountId),
  );
};
