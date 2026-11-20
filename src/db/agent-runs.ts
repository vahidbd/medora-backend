import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * The agents service's claim (docs/decisions/agents.md AGT8): the one query
 * agents make across tenants, through the reviewed function
 * platform.claim_agent_runs. It returns ids only; everything after it runs
 * inside the run's own tenant (ADR 0006).
 */
export interface ClaimedRun {
  runId: string;
  tenantId: string;
  /** claimed: this process runs it now. abandoned: its worker died, so it was failed and its conversation goes to a person. */
  outcome: 'claimed' | 'abandoned';
}

export async function claimAgentRuns(leaseSeconds: number, tenantLimit: number): Promise<ClaimedRun[]> {
  const result = await db.execute<{ run_id: string; tenant_id: string; outcome: 'claimed' | 'abandoned' }>(
    sql`select run_id, tenant_id, outcome from platform.claim_agent_runs(${leaseSeconds}, ${tenantLimit})`,
  );
  return result.rows.map((row) => ({ runId: row.run_id, tenantId: row.tenant_id, outcome: row.outcome }));
}
