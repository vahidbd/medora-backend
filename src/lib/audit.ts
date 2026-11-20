import type { Actor, TenantTx } from '../db/tenant.js';
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

function actorIdOf(actor: Actor): string | null {
  switch (actor.type) {
    case 'person':
      return actor.userId;
    case 'patient':
      return actor.patientId;
    case 'agent':
      return actor.agentId;
    case 'system':
      return null;
  }
}

export async function audit(tx: TenantTx, entry: AuditEntry): Promise<void> {
  const { actor, tenantId, requestId } = tx.context;
  await tx.db.insert(auditLog).values({
    tenantId,
    actorType: actor.type,
    actorId: actorIdOf(actor),
    action: entry.action,
    zone: entry.zone,
    recordTable: entry.recordTable,
    recordId: entry.recordId,
    requestId,
    details: entry.details ?? {},
  });
}
