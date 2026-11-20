import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { cancelBody, pauseBody, subscription, subscriptionParams, subscriptionsQuery, subscriptionsReply } from './subscriptions.schemas.js';
import {
  cancelSubscription,
  getSubscription,
  listSubscriptions,
  pauseSubscription,
  reinstateSubscription,
  resumeSubscription,
  skipNextPeriod,
} from './subscriptions.service.js';

/** Staff change a subscription for the patient (BIL22). The support agent's tools for this are decided with that agent (ADR 0012). */
const NO_AGENT = { none: 'Staff change subscriptions for now; the support agent gets its tools when it is built (ADR 0012)' };
const read = { permission: 'subscriptions:read' } as const;
const manage = { permission: 'subscriptions:manage' } as const;
const tags = ['billing'];

export const subscriptionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/subscriptions',
    { config: { access: read }, schema: { tags, summary: "The tenant's subscriptions, newest first", querystring: subscriptionsQuery, response: { 200: subscriptionsReply } } },
    async (request) => ({ subscriptions: await withTenant(tenantContextOf(request), (tx) => listSubscriptions(tx, request.query)) }),
  );

  app.get(
    '/subscriptions/:subscriptionId',
    { config: { access: read }, schema: { tags, summary: 'One subscription', params: subscriptionParams, response: { 200: subscription } } },
    async (request) => withTenant(tenantContextOf(request), (tx) => getSubscription(tx, request.params.subscriptionId)),
  );

  app.post(
    '/subscriptions/:subscriptionId/pause',
    {
      config: { access: manage, audit: ['subscription.paused'], events: ['subscription.paused'], agentTool: NO_AGENT },
      schema: { tags, summary: 'No invoice until the resume date, at most three months on', params: subscriptionParams, body: pauseBody, response: { 200: subscription } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => pauseSubscription(tx, request.params.subscriptionId, request.body.resumesOn)),
  );

  app.post(
    '/subscriptions/:subscriptionId/resume',
    {
      config: { access: manage, audit: ['subscription.resumed'], events: ['subscription.resumed'], agentTool: NO_AGENT },
      schema: { tags, summary: 'End a pause: the next period starts when the current one ends, or is due now if that has passed', params: subscriptionParams, response: { 200: subscription } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => resumeSubscription(tx, request.params.subscriptionId)),
  );

  app.post(
    '/subscriptions/:subscriptionId/skip',
    {
      config: { access: manage, audit: ['subscription.skipped'], events: ['subscription.skipped'], agentTool: NO_AGENT },
      schema: { tags, summary: 'Move the next billing period one interval later', params: subscriptionParams, response: { 200: subscription } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => skipNextPeriod(tx, request.params.subscriptionId)),
  );

  app.post(
    '/subscriptions/:subscriptionId/cancel',
    {
      config: {
        access: manage,
        audit: ['subscription.cancellation_scheduled', 'subscription.cancelled'],
        events: ['subscription.cancellation_scheduled', 'subscription.cancelled'],
        agentTool: NO_AGENT,
      },
      schema: { tags, summary: "End it at the current period's end, or now", params: subscriptionParams, body: cancelBody, response: { 200: subscription } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => cancelSubscription(tx, request.params.subscriptionId, request.body)),
  );

  app.post(
    '/subscriptions/:subscriptionId/reinstate',
    {
      config: { access: manage, audit: ['subscription.reinstated'], events: ['subscription.reinstated'], agentTool: NO_AGENT },
      schema: { tags, summary: 'Keep a subscription that was due to end at its period end', params: subscriptionParams, response: { 200: subscription } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => reinstateSubscription(tx, request.params.subscriptionId)),
  );
};
