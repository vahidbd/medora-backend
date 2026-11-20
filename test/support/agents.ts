import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import type { AgentKind } from '../../src/db/schema/values.js';
import { withTenant } from '../../src/db/tenant.js';
import { audit } from '../../src/lib/audit.js';
import { resultsPath } from '../../src/modules/agents/evals.js';
import { agentVersion } from '../../src/modules/agents/policy.js';
import { tenantContextOf } from '../../src/plugins/auth.js';

/**
 * Stand-ins for the routes other modules will add as agent tools, under
 * names from the tool policy, so the runtime treats them exactly as it will
 * treat the real ones. Test apps only; each records what reached it.
 */
export const toolCalls: { tool: string; input: Record<string, unknown>; idempotencyKey: string | undefined }[] = [];

const testTools: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/test/patients/:patientId/consults',
    {
      config: { access: { permission: 'agents:read' }, audit: ['test.booked'], events: { none: 'test route' }, agentTool: 'book_consult' },
      schema: {
        summary: 'Book a consult for the patient at one of the offered times',
        params: z.object({ patientId: z.uuid() }),
        body: z.object({ brandId: z.uuid(), startsAt: z.iso.datetime({ offset: true }) }),
        response: { 201: z.object({ booked: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      toolCalls.push({ tool: 'book_consult', input: { ...request.params, ...request.body }, idempotencyKey: request.headers['idempotency-key'] as string | undefined });
      await withTenant(tenantContextOf(request), (tx) =>
        audit(tx, { action: 'test.booked', zone: 'platform', recordTable: 'platform.tenants', recordId: tx.context.tenantId, details: { patientId: request.params.patientId } }),
      );
      return reply.code(201).send({ booked: true as const });
    },
  );

  app.get(
    '/test/patients/:patientId/next-consult',
    {
      config: { access: { permission: 'agents:read' }, agentTool: 'get_next_consult' },
      schema: {
        summary: "The patient's next consult",
        params: z.object({ patientId: z.uuid() }),
        response: { 200: z.object({ patientId: z.uuid(), startsAt: z.string() }) },
      },
    },
    async (request) => {
      toolCalls.push({ tool: 'get_next_consult', input: { ...request.params }, idempotencyKey: undefined });
      return { patientId: request.params.patientId, startsAt: '2026-12-01T09:00:00+11:00' };
    },
  );
  app.post(
    '/test/patients/:patientId/refunds',
    {
      config: { access: { permission: 'agents:read' }, audit: { none: 'test route' }, events: { none: 'test route' }, agentTool: 'request_refund' },
      schema: {
        summary: 'Refund part or all of one of the patient\'s orders',
        params: z.object({ patientId: z.uuid() }),
        body: z.object({ orderId: z.string(), amountCents: z.number().int().min(1) }),
        response: { 201: z.object({ refunded: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      toolCalls.push({ tool: 'request_refund', input: { ...request.params, ...request.body }, idempotencyKey: request.headers['idempotency-key'] as string | undefined });
      return reply.code(201).send({ refunded: true as const });
    },
  );
};

export async function agentTestApp(): Promise<App> {
  const app = await buildApp();
  await app.register(testTools, { prefix: '/v1' });
  await app.ready();
  return app;
}

/** The platform switch on, and eval results in a folder of this test file's own. */
export function agentsOn(): void {
  env.AGENTS_ENABLED = 'true';
  env.AGENT_EVAL_RESULTS_DIR = mkdtempSync(join(tmpdir(), 'medora-evals-'));
}

/** A recorded pass for the version that would run now. */
export function passEvals(app: App, ...agents: AgentKind[]): void {
  for (const agent of agents) {
    writeFileSync(
      resultsPath(agent),
      JSON.stringify({ agent, version: agentVersion(agent, app.agentTools), model: 'test', passed: true, cases: 1, failed: [], ranAt: new Date().toISOString() }),
    );
  }
}
