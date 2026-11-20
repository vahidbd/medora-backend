import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { openConversation, receiveMessage } from '../../src/modules/agents/index.js';
import { agentTestApp, agentsOn, passEvals } from '../support/agents.js';
import { headers, signIn } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/** Another tenant can't read, change or delete any agent table's rows (ADR 0006). */
let app: App;
/** Each table and a column the API may update, so a refused change is row-level security's doing, not a missing grant. */
const COLUMNS = {
  'platform.agent_settings': 'enabled',
  'platform.agent_tenant_settings': 'paused',
  'platform.agent_runs': 'status',
  'clinical.agent_conversations': 'status',
  'clinical.agent_messages': null,
  'clinical.agent_proposals': 'status',
} as const;
const TABLES = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[];

const as = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });

beforeAll(async () => {
  app = await agentTestApp();
  agentsOn();
  passEvals(app, 'support');
});
afterAll(async () => {
  await admin.query("update platform.agent_runs set status = 'stopped', end_reason = 'test_cleanup', ended_at = now() where status = 'queued'");
  await app.close();
  await closeDatabase();
  await admin.end();
});

describe('agent tables are tenant-isolated', async () => {
  const a = await tenantWith('owner');
  const b = await tenantWith('owner');

  beforeAll(async () => {
    const token = await signIn(b.members[0]!.email);
    await app.inject({ method: 'PATCH', url: '/v1/agents/support', headers: headers(token, b.tenantId), payload: { enabled: true } });
    await app.inject({ method: 'POST', url: '/v1/agents/pause', headers: headers(token, b.tenantId) });
    await app.inject({ method: 'POST', url: '/v1/agents/resume', headers: headers(token, b.tenantId) });
    const opened = await withTenant(as(b.tenantId), (tx) => openConversation(tx, { agent: 'support', channel: 'email' }));
    if (!('conversationId' in opened)) throw new Error('the agent should be on');
    await withTenant(as(b.tenantId), (tx) => receiveMessage(tx, { conversationId: opened.conversationId, text: 'Where is my order?', from: 'patient' }));
    const run = (await admin.query('select id, agent_id from platform.agent_runs where tenant_id = $1', [b.tenantId])).rows[0];
    await admin.query(
      `insert into clinical.agent_proposals (tenant_id, agent, agent_id, run_id, conversation_id, tool, permission, input, idempotency_key, expires_at)
       values ($1, 'support', $2, $3, $4, 'request_refund', 'agents:read', '{}', 'tenancy-test', now() + interval '1 day')`,
      [b.tenantId, run.agent_id, run.id, opened.conversationId],
    );
  });

  it.each(TABLES)("%s: tenant B's rows exist", async (table) => {
    const { rows } = await admin.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [b.tenantId]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it.each(TABLES)("%s: tenant A can't read, change or delete them", async (table) => {
    const seen = await withTenant(as(a.tenantId), async (tx) => {
      const read = await tx.db.execute(sql.raw(`select tenant_id from ${table}`));
      const column = COLUMNS[table];
      const changed = column ? (await tx.db.execute(sql.raw(`update ${table} set ${column} = ${column}`))).rowCount : 0;
      return { read: read.rows, changed };
    });
    expect(seen.read.every((row) => (row as { tenant_id: string }).tenant_id === a.tenantId)).toBe(true);
    expect(seen.changed).toBe(0);
    // Nothing is deleted in v1 (AGT3): not even a tenant's own rows.
    await expect(withTenant(as(a.tenantId), (tx) => tx.db.execute(sql.raw(`delete from ${table}`)))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });
});
