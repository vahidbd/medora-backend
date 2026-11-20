import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { removedReply, sender, senderBody, senderListReply, senderParams } from './messaging.schemas.js';
import { listSenders, removeSender, setSender } from './senders.service.js';

const noAgent = {
  none: 'Where a brand sends from is set by a person (docs/decisions/messaging.md CRM5)',
};
const noEvents = {
  none: 'Nothing reacts to a sender changing; sends read the current address',
};

export const messagingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/senders',
    {
      config: { access: { permission: 'messaging:manage' } },
      schema: {
        tags: ['messaging'],
        summary: "Each brand's email address and SMS number",
        response: { 200: senderListReply },
      },
    },
    async (request) => ({
      senders: await withTenant(tenantContextOf(request), listSenders),
    }),
  );

  app.put(
    '/senders',
    {
      config: {
        access: { permission: 'messaging:manage' },
        audit: ['sender.set'],
        events: noEvents,
        agentTool: noAgent,
      },
      schema: {
        tags: ['messaging'],
        summary: "Set a brand's address on a channel",
        body: senderBody,
        response: { 200: sender },
      },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => setSender(tx, request.body)),
  );

  app.delete(
    '/senders/:senderId',
    {
      config: {
        access: { permission: 'messaging:manage' },
        audit: ['sender.removed'],
        events: noEvents,
        agentTool: noAgent,
      },
      schema: {
        tags: ['messaging'],
        summary: "Remove a brand's address",
        params: senderParams,
        response: { 200: removedReply },
      },
    },
    async (request) => {
      await withTenant(tenantContextOf(request), (tx) => removeSender(tx, request.params.senderId));
      return { removed: true as const };
    },
  );
};
