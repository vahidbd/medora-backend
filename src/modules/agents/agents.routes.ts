import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { listRuns, readConversation } from './activity.service.js';
import { agentChangeBody, agentParams, agentSummary, agentsReply, conversationParams, conversationReply, pauseReply, runsQuery, runsReply } from './agents.schemas.js';
import { listAgents, setPaused, updateAgent } from './settings.service.js';

const byAPerson = { none: 'Agents never change their own settings or switches (docs/decisions/agents.md AGT5)' };

export const agentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/agents',
    {
      config: { access: { permission: 'agents:read' } },
      schema: { tags: ['agents'], summary: "The tenant's agents: whether each is on, its version, tools, caps and use", response: { 200: agentsReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => listAgents(tx, app.agentTools)),
  );

  app.patch(
    '/agents/:agent',
    {
      config: { access: { permission: 'agents:manage' }, audit: ['agent_settings.changed'], events: ['agent_settings.changed'], agentTool: byAPerson },
      schema: { tags: ['agents'], summary: "Switch an agent on or off, or change its name, caps and auto tools", params: agentParams, body: agentChangeBody, response: { 200: agentSummary } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => updateAgent(tx, request.params.agent, request.body, app.agentTools)),
  );

  for (const [path, paused] of [['/agents/pause', true], ['/agents/resume', false]] as const) {
    app.post(
      path,
      {
        config: { access: { permission: 'agents:manage' }, audit: ['agent_tenant_settings.changed'], events: ['agent_tenant_settings.changed'], agentTool: byAPerson },
        schema: { tags: ['agents'], summary: paused ? 'Pause every agent in the tenant' : "Resume the tenant's agents, each as it was set", response: { 200: pauseReply } },
      },
      async (request) => withTenant(tenantContextOf(request), (tx) => setPaused(tx, paused)),
    );
  }

  app.get(
    '/agent-runs',
    {
      config: { access: { permission: 'agents:read' } },
      schema: { tags: ['agents'], summary: 'Agent runs, newest first: what triggered each, how it ended and what it cost', querystring: runsQuery, response: { 200: runsReply } },
    },
    async (request) => ({ runs: await withTenant(tenantContextOf(request), (tx) => listRuns(tx, request.query)) }),
  );

  app.get(
    '/agent-conversations/:conversationId',
    {
      config: { access: { permission: 'agents:transcripts' } },
      schema: { tags: ['agents'], summary: "One conversation's model-side transcript (audited)", params: conversationParams, response: { 200: conversationReply } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => readConversation(tx, request.params.conversationId)),
  );
};
