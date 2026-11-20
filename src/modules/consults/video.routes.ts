import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import type { TenantTx } from '../../db/tenant.js';
import { postgresError } from '../../lib/database-errors.js';
import { BadRequestError, ForbiddenError } from '../../lib/errors.js';
import { acceptRawBodies, onWebhook, receiveWebhook, type WebhookDelivery } from '../../lib/webhooks.js';
import { recordConnection, recordFinish } from './evidence.service.js';
import { participantOf, roomOf, VIDEO_EVIDENCE_KINDS, type VideoEvidenceKind, videoCallback, videoWebhookVerified } from './video-room.js';

/**
 * The video server's webhooks (ADR 0120, docs/decisions/consults.md CNS7).
 * One address for every tenant, because the server has one: the tenant comes
 * from the room's name, which Medora set. Verified, stored in the inbox, then
 * turned into consult evidence by the handler below.
 */

const refused = () => new ForbiddenError("This webhook wasn't accepted", 'webhook_refused');
const isEvidenceKind = (kind: string): kind is VideoEvidenceKind => (VIDEO_EVIDENCE_KINDS as readonly string[]).includes(kind);

async function onVideoCallback(tx: TenantTx, delivery: WebhookDelivery): Promise<void> {
  const callback = videoCallback.parse(delivery.body);
  const room = roomOf(callback.room?.name);
  if (!room || room.tenantId !== tx.context.tenantId) return;
  const at = new Date(callback.createdAt * 1000);
  if (callback.event === 'room_finished') {
    await recordFinish(tx, delivery, { consultId: room.consultId, channel: 'video', at });
    return;
  }
  const participant = participantOf(callback.participant?.identity);
  if (!participant) return;
  const event = callback.event === 'participant_joined' ? 'connected' : 'disconnected';
  await recordConnection(tx, delivery, { consultId: room.consultId, channel: 'video', at, event, participant });
}

export const videoRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const kind of VIDEO_EVIDENCE_KINDS) onWebhook('video', kind, onVideoCallback);
  acceptRawBodies(app);

  app.post(
    '/webhooks/video',
    {
      config: {
        access: 'public',
        audit: { none: 'Stores the delivery only; the handler that processes it writes the audit entries' },
        events: { none: 'Stores the delivery only; the handler that processes it emits consult.started and consult.completed' },
        agentTool: { none: 'Only the video server calls this; no agent can make consult evidence' },
      },
      schema: {
        tags: ['webhooks'],
        summary: "The video server's calls about rooms and participants",
        security: [],
        body: z.string(),
        response: { 200: z.object({ stored: z.boolean() }) },
      },
    },
    async (request) => {
      const authorization = request.headers.authorization;
      if (!(await videoWebhookVerified(request.body, authorization, env.VIDEO_API_KEY, env.VIDEO_API_SECRET))) throw refused();
      let body: unknown;
      try {
        body = JSON.parse(request.body);
      } catch {
        throw new BadRequestError('The webhook body is not JSON');
      }
      const parsed = videoCallback.safeParse(body);
      if (!parsed.success) throw new BadRequestError('The webhook body is not a video server event');
      const room = roomOf(parsed.data.room?.name);
      // Callbacks that can't be evidence, or rooms that aren't a consult's, are answered and dropped.
      if (!room || !isEvidenceKind(parsed.data.event)) return { stored: false };
      try {
        await receiveWebhook({ tenantId: room.tenantId, requestId: request.id }, { provider: 'video', providerEventId: parsed.data.id, kind: parsed.data.event, body });
      } catch (error) {
        if (postgresError(error)?.code === '23503') return { stored: false };
        throw error;
      }
      return { stored: true };
    },
  );
};
