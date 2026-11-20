import type { TenantTx } from '../db/tenant.js';
import { auditLog } from '../db/schema/index.js';
import type { DataZone } from '../db/schema/values.js';

/**
 * Every write, and every read of clinical data, writes an audit entry in the
 * same transaction as the work (ADR 0008): they commit together or not at all.
 * Details hold ids and facts only: never names, contact details or clinical text.
 */
export interface AuditEntry {
  /** `<record>.<verb>`, e.g. `membership.role_changed`. */
  action: `${string}.${string}`;
  zone: DataZone;
  /** Schema-qualified, e.g. `platform.memberships`. */
  recordTable: `${string}.${string}`;
  recordId: string;
  details?: Record<string, string | number | boolean | null>;
}

export async function audit(tx: TenantTx, entry: AuditEntry): Promise<void> {
  const { actor, tenantId, requestId } = tx.context;
  await tx.db.insert(auditLog).values({
    tenantId,
    actorType: actor.type,
    actorId: actor.type === 'person' ? actor.userId : actor.type === 'agent' ? actor.agentId : null,
    action: entry.action,
    zone: entry.zone,
    recordTable: entry.recordTable,
    recordId: entry.recordId,
    requestId,
    details: entry.details ?? {},
  });
}
