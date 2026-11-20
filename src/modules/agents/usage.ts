import { sql } from 'drizzle-orm';
import type { AgentKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';

/**
 * What an agent has used, for its limits (docs/decisions/agents.md AGT6).
 * "Today" and "this month" are the tenant's (ADR 0017). A run is one reply
 * at most, so runs stand in for replies.
 */
const startOf = (unit: 'day' | 'month', timeZone: string) => sql`(date_trunc(${unit}, now() at time zone ${timeZone}) at time zone ${timeZone})`;

export async function monthSpendCents(tx: TenantTx, agent: AgentKind, timeZone: string): Promise<number> {
  const result = await tx.db.execute<{ cents: string | null }>(
    sql`select coalesce(sum(cost_cents), 0) as cents from platform.agent_runs
         where tenant_id = ${tx.context.tenantId} and agent = ${agent} and queued_at >= ${startOf('month', timeZone)}`,
  );
  return Number(result.rows[0]?.cents ?? 0);
}

export async function runsToday(tx: TenantTx, agent: AgentKind, timeZone: string): Promise<number> {
  const result = await tx.db.execute<{ runs: string }>(
    sql`select count(*) as runs from platform.agent_runs
         where tenant_id = ${tx.context.tenantId} and agent = ${agent} and status <> 'queued' and started_at >= ${startOf('day', timeZone)}`,
  );
  return Number(result.rows[0]?.runs ?? 0);
}

export async function conversationRunsToday(tx: TenantTx, conversationId: string, timeZone: string): Promise<number> {
  const result = await tx.db.execute<{ runs: string }>(
    sql`select count(*) as runs from platform.agent_runs
         where tenant_id = ${tx.context.tenantId} and conversation_id = ${conversationId} and status <> 'queued' and started_at >= ${startOf('day', timeZone)}`,
  );
  return Number(result.rows[0]?.runs ?? 0);
}
