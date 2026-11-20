import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { agentRoutes as settingsRoutes } from './agents.routes.js';
import { proposalRoutes } from './proposals.routes.js';

/**
 * AI agents (ADRs 0012, 0240; docs/decisions/agents.md): the runtime, the
 * tool catalogue's policy, approval cards, limits, the safety screen and the
 * launch agents. The module's front door (ADR 0027).
 *
 * Other modules hand work to an agent with openConversation, receiveMessage
 * and startJob, deliver its replies with readReply when the
 * `agent_message.created` event arrives, and take a conversation back with
 * handBack once a person has dealt with it.
 */
export const agentRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(settingsRoutes);
  await app.register(proposalRoutes);
};

export { type ConversationStart, type IncomingMessage, type Opened, type Received, handBack, openConversation, readReply, receiveMessage, startJob } from './conversations.service.js';
export { AGENT_DEFINITIONS, aiDisclosure } from './definitions.js';
export { configuredModelClient } from './model/index.js';
export { catalogueProblems } from './policy.js';
export { type KnownValue } from './runtime/masking.js';
export { screenMessage } from './runtime/safety-screen.js';
export { agentsLoop } from './service.js';
