import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import { approveBody, proposal, proposalParams, proposalsQuery, proposalsReply, rejectBody } from './agents.schemas.js';
import { approveProposal, getProposal, listProposals, recordOutcome, rejectProposal } from './proposals.service.js';
import { ToolRefused, callTool } from './runtime/tools.js';

const REFUSALS = {
  expired: 'This card has expired. The agent can propose it again.',
  agent_off: "This agent is switched off, so its cards can be rejected but not approved.",
  tool_changed: 'What this card would run has changed since it was made, so it was not run.',
  already_decided: 'This card has already been decided.',
} as const;

const onlyPeople = { none: 'Only a person decides an approval card (docs/decisions/agents.md AGT12)' };

/**
 * The approvals inbox (docs/decisions/agents.md AGT4, AGT12). Anyone in the
 * tenant may open it, and sees only the cards they could approve: those
 * whose route needs a permission they can use now.
 */
export const proposalRoutes: FastifyPluginAsyncZod = async (app) => {
  const viewer = (request: Parameters<typeof requireTenant>[0]) => {
    const { auth, tenant } = requireTenant(request);
    return { userId: auth.userId, permissions: tenant.permissions };
  };

  app.get(
    '/agent-proposals',
    {
      config: { access: 'member' },
      schema: { tags: ['agents'], summary: 'Approval cards you could approve (each read audited)', querystring: proposalsQuery, response: { 200: proposalsReply } },
    },
    async (request) => {
      const { permissions } = viewer(request);
      return { proposals: await withTenant(tenantContextOf(request), (tx) => listProposals(tx, permissions, request.query.state)) };
    },
  );

  app.get(
    '/agent-proposals/:proposalId',
    {
      config: { access: 'member' },
      schema: { tags: ['agents'], summary: 'One approval card (audited)', params: proposalParams, response: { 200: proposal } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => getProposal(tx, request.params.proposalId, viewer(request).permissions)),
  );

  app.post(
    '/agent-proposals/:proposalId/approve',
    {
      config: {
        access: 'member',
        audit: ['agent_proposal.approved', 'agent_proposal.executed', 'agent_proposal.failed', 'agent_proposal.expired'],
        events: ['agent_proposal.approved', 'agent_proposal.executed', 'agent_proposal.failed', 'agent_proposal.expired'],
        agentTool: onlyPeople,
      },
      schema: { tags: ['agents'], summary: 'Approve a card, with your edits, and run it once', params: proposalParams, body: approveBody, response: { 200: proposal } },
    },
    async (request) => {
      const person = viewer(request);
      const context = tenantContextOf(request);
      const approval = await withTenant(context, (tx) => approveProposal(tx, request.params.proposalId, person, request.body, app.agentTools));
      if (approval.kind === 'refused') throw new BusinessRuleError(REFUSALS[approval.code], `proposal_${approval.code}`);
      // The route runs after the approval commits, as the agent, narrowed to the approver (AGT2, ADR 0029).
      let outcome: { status: number } | { refused: string };
      try {
        const result = await callTool(app, {
          tenantId: context.tenantId,
          agentId: approval.agentId,
          agent: approval.proposal.agent,
          runId: approval.proposal.runId,
          tool: approval.tool,
          input: approval.input,
          pinned: approval.pinned,
          person: person.permissions,
          approvedBy: person.userId,
          idempotencyKey: approval.idempotencyKey,
        });
        outcome = { status: result.status };
      } catch (error) {
        if (!(error instanceof ToolRefused)) throw error;
        outcome = { refused: error.code };
      }
      return withTenant(context, (tx) => recordOutcome(tx, request.params.proposalId, outcome));
    },
  );

  app.post(
    '/agent-proposals/:proposalId/reject',
    {
      config: { access: 'member', audit: ['agent_proposal.rejected'], events: ['agent_proposal.rejected'], agentTool: onlyPeople },
      schema: { tags: ['agents'], summary: 'Reject a card, with a reason', params: proposalParams, body: rejectBody, response: { 200: proposal } },
    },
    async (request) => withTenant(tenantContextOf(request), (tx) => rejectProposal(tx, request.params.proposalId, viewer(request), request.body.reason)),
  );
};
