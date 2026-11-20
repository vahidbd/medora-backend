import { sql } from 'drizzle-orm';
import { db, type DbTx } from './client.js';

/**
 * The only way feature code reaches the database (ADR 0006). One transaction
 * that names its tenant and the person or agent acting, with
 * set_config(..., true), so the settings end with the transaction and never
 * leak to the next request on a pooled connection. Row-level security does
 * the rest: inside, only this tenant's rows exist.
 */

export type Actor = { type: 'person'; userId: string } | { type: 'agent'; agentId: string } | { type: 'system' };

export interface TenantContext {
  tenantId: string;
  actor: Actor;
  /** The request or job run this work belongs to, for the audit log. */
  requestId: string | null;
}

/** A transaction inside one tenant: what services, audit() and emitEvent() take. */
export interface TenantTx {
  readonly db: DbTx;
  readonly context: TenantContext;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(context: TenantContext, work: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!UUID.test(context.tenantId)) throw new Error('withTenant needs a tenant id');
  const userId = context.actor.type === 'person' ? context.actor.userId : '';
  return db.transaction(async (dbTx) => {
    await dbTx.execute(
      sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.user_id', ${userId}, true)`,
    );
    return work({ db: dbTx, context });
  });
}
