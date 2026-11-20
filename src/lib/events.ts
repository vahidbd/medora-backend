import type { TenantTx } from '../db/tenant.js';
import { outbox } from '../db/schema/index.js';

/**
 * Events go to the outbox in the same transaction as the change they describe
 * (ADR 0016): if the change commits, the event exists; if it rolls back, it
 * doesn't. Delivery reads the outbox after commit (ADR 0029). Events carry
 * ids and business facts, never names, contact details or clinical text.
 */
type Fact = string | number | boolean | null;

export interface EventInput {
  /** `<record>.<past-tense verb>`, e.g. `membership.role_changed`. */
  type: `${string}.${string}`;
  recordTable: `${string}.${string}`;
  recordId: string;
  payload?: Record<string, Fact | Fact[]>;
}

export async function emitEvent(tx: TenantTx, event: EventInput): Promise<void> {
  await tx.db.insert(outbox).values({
    tenantId: tx.context.tenantId,
    type: event.type,
    recordTable: event.recordTable,
    recordId: event.recordId,
    payload: event.payload ?? {},
    requestId: tx.context.requestId,
  });
}
