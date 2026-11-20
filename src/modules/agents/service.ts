import type { FastifyInstance } from 'fastify';
import { claimAgentRuns } from '../../db/agent-runs.js';
import { safeErrorMessage } from '../../lib/redact.js';
import type { ModelClient } from './model/client.js';
import { RUN_SECONDS, handOffAbandoned, runAgentRun } from './runtime/runner.js';

/**
 * The agents service's loop (docs/decisions/agents.md AGT8): claim queued
 * runs, a few at a time, and run each to its end. Many copies can run side
 * by side; the claim keeps one run per conversation and a limit per tenant.
 */
export interface AgentsLoopOptions {
  app: FastifyInstance;
  model: ModelClient;
  log: { error(details: object, message?: string): void; warn(details: object, message?: string): void };
  /** Runs this process does at once. */
  concurrency?: number;
  /** Runs one tenant may have going at once, across every copy (AGT8). */
  tenantLimit?: number;
}

/** Long enough for the longest run, so only a dead worker's lease runs out. */
export const LEASE_SECONDS = RUN_SECONDS + 60;

export function agentsLoop(options: AgentsLoopOptions) {
  const concurrency = options.concurrency ?? 4;
  const tenantLimit = options.tenantLimit ?? 2;
  const running = new Set<Promise<void>>();

  /** Claim and start what fits; resolves once the claims are made, not when the runs end. */
  async function tick(): Promise<number> {
    let started = 0;
    while (running.size < concurrency) {
      const claimed = await claimAgentRuns(LEASE_SECONDS, tenantLimit);
      for (const run of claimed.filter((c) => c.outcome === 'abandoned')) {
        options.log.warn({ runId: run.runId, tenantId: run.tenantId }, 'agent run abandoned by a worker that stopped; handed to a person');
        await handOffAbandoned(run);
      }
      const next = claimed.filter((c) => c.outcome === 'claimed');
      if (next.length === 0) break;
      for (const run of next) {
        const work: Promise<void> = runAgentRun({ app: options.app, model: options.model }, run)
          .catch((error: unknown) => {
            options.log.error({ runId: run.runId, tenantId: run.tenantId, error: error instanceof Error ? safeErrorMessage(error) : 'unknown' }, 'agent run failed');
          })
          .finally(() => running.delete(work));
        running.add(work);
        started += 1;
      }
    }
    return started;
  }

  /** Every run started so far, ended. */
  async function drain(): Promise<void> {
    await Promise.all([...running]);
  }

  return { tick, drain, get running() { return running.size; } };
}
