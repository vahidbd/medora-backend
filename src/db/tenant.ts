import { sql } from 'drizzle-orm';
import { db, type DbTx } from './client.js';

export type { DbTx } from './client.js';

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

/**
 * A transaction for the signed-in person's own rows when no tenant is chosen,
 * such as their sign-in history (docs/decisions/admin.md ADM6). Only
 * `app.user_id` is set, so every tenant policy matches nothing.
 */
export interface PersonTx {
  readonly db: DbTx;
  readonly userId: string;
}

export async function withPerson<T>(userId: string, work: (tx: PersonTx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error('withPerson needs a user id');
  return db.transaction(async (dbTx) => {
    await dbTx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.user_id', ${userId}, true)`);
    return work({ db: dbTx, userId });
  });
}

/**
 * A transaction for a public page, before any tenant or person is known,
 * such as finding the brand a host belongs to (docs/decisions/admin.md
 * ADM16). Nothing is set, so every policy matches nothing: only the reviewed
 * functions answer.
 */
export interface PublicTx {
  readonly db: DbTx;
}

export async function withPublic<T>(work: (tx: PublicTx) => Promise<T>): Promise<T> {
  return db.transaction(async (dbTx) => {
    await dbTx.execute(sql`select set_config('app.tenant_id', '', true), set_config('app.user_id', '', true)`);
    return work({ db: dbTx });
  });
}
