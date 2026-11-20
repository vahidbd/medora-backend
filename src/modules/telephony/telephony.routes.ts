import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { postgresError } from '../../lib/database-errors.js';
import { ForbiddenError } from '../../lib/errors.js';
import { acceptRawBodies, receiveWebhook } from '../../lib/webhooks.js';
import { twilioSignatureMatches } from './twilio-signature.js';

/**
 * Twilio's webhooks (docs/decisions/telephony.md TEL2). Each is checked
 * against Twilio's signature, stored in the inbox and processed by the
 * module that registered its kind: SMS by support and CRM, calls by consults.
 */
const HOOKS = {
  'sms-inbound': { kind: 'sms.inbound', eventId: (p: URLSearchParams) => p.get('MessageSid') },
  'sms-status': { kind: 'sms.status', eventId: (p: URLSearchParams) => statusEventId(p.get('MessageSid'), p.get('MessageStatus')) },
  'voice-status': {
    kind: 'voice.status',
    eventId: (p: URLSearchParams) => statusEventId(p.get('CallSid'), p.get('CallStatus'), p.get('SequenceNumber')),
  },
} as const;

type Hook = keyof typeof HOOKS;

function statusEventId(sid: string | null, ...parts: (string | null)[]): string | null {
  if (!sid || parts[0] === null) return null;
  return [sid, ...parts.filter((part) => part !== null)].join(':');
}

/** An empty TwiML reply: Twilio does nothing more, and sends no reply text. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const refused = () => new ForbiddenError("This webhook wasn't accepted", 'webhook_refused');

export const telephonyRoutes: FastifyPluginAsyncZod = async (app) => {
  acceptRawBodies(app);

  app.post(
    '/webhooks/twilio/:tenantId/:hook',
    {
      config: {
        access: 'public',
        audit: { none: 'Stores the delivery only; the handler that processes it writes the audit entries' },
        events: { none: 'Stores the delivery only; the handler that processes it emits the events' },
        agentTool: { none: 'Only Twilio calls this' },
      },
      schema: {
        tags: ['webhooks'],
        summary: "Twilio's calls about SMS and phone calls",
        security: [],
        params: z.object({ tenantId: z.uuid(), hook: z.enum(Object.keys(HOOKS) as [Hook, ...Hook[]]) }),
        body: z.string(),
        response: { 200: z.string() },
      },
    },
    async (request, reply) => {
      const params = new URLSearchParams(request.body);
      const url = `${(env.PUBLIC_API_URL ?? '').replace(/\/$/, '')}${request.url}`;
      const signature = request.headers['x-twilio-signature'];
      if (!env.PUBLIC_API_URL || !twilioSignatureMatches(env.TWILIO_AUTH_TOKEN, url, params, typeof signature === 'string' ? signature : undefined)) {
        throw refused();
      }
      const hook = HOOKS[request.params.hook];
      const providerEventId = hook.eventId(params);
      if (!providerEventId) throw refused();
      try {
        await receiveWebhook(
          { tenantId: request.params.tenantId, requestId: request.id },
          { provider: 'twilio', providerEventId, kind: hook.kind, body: Object.fromEntries(params) },
        );
      } catch (error) {
        // A tenant that doesn't exist answers like a bad signature, so the reply reveals nothing.
        if (postgresError(error)?.code === '23503') throw refused();
        throw error;
      }
      return reply.type('text/xml').send(EMPTY_TWIML);
    },
  );
};
