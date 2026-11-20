import { and, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm';
import { auditLog, users } from '../../db/schema/index.js';
import type { ActorType, DataZone } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import type { AuditEntryView, AuditFilter } from './audit.schemas.js';

/**
 * The tenant's audit log, read by those holding audit:read
 * (docs/decisions/admin.md ADM25), newest first. Row-level security keeps
 * it to the tenant's own entries; platform-level ones belong to no tenant
 * and never show. An export writes its own audit entry (ADM26).
 */

/** The most entries one export holds. */
export const EXPORT_MAX = 5000;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function conditions(tx: TenantTx, filter: AuditFilter): SQL[] {
  const where: SQL[] = [eq(auditLog.tenantId, tx.context.tenantId)];
  if (filter.from) where.push(gte(auditLog.at, new Date(filter.from)));
  if (filter.to) where.push(lt(auditLog.at, new Date(filter.to)));
  if (filter.actorId) where.push(eq(auditLog.actorId, filter.actorId));
  if (filter.action) where.push(like(auditLog.action, `${escapeLike(filter.action)}%`));
  if (filter.recordTable) where.push(eq(auditLog.recordTable, filter.recordTable));
  if (filter.recordId) where.push(eq(auditLog.recordId, filter.recordId));
  if (filter.zone) where.push(eq(auditLog.zone, filter.zone));
  return where;
}

async function entries(tx: TenantTx, where: SQL[], limit: number): Promise<AuditEntryView[]> {
  const rows = await tx.db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorType: auditLog.actorType,
      actorId: auditLog.actorId,
      // Only people this tenant can see (its own staff) get a name; RLS on users decides.
      actorName: sql<string | null>`coalesce(${users.displayName}, ${users.email})`,
      action: auditLog.action,
      zone: auditLog.zone,
      recordTable: auditLog.recordTable,
      recordId: auditLog.recordId,
      requestId: auditLog.requestId,
      details: auditLog.details,
    })
    .from(auditLog)
    .leftJoin(users, and(eq(auditLog.actorType, 'person'), eq(users.id, auditLog.actorId)))
    .where(and(...where))
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return rows.map((row) => ({
    entryId: String(row.id),
    at: row.at.toISOString(),
    actorType: row.actorType as ActorType,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    zone: row.zone as DataZone,
    recordTable: row.recordTable,
    recordId: row.recordId,
    requestId: row.requestId,
    details: row.details as AuditEntryView['details'],
  }));
}

/** One page of entries, newest first, and where the next page starts. */
export async function searchAudit(
  tx: TenantTx,
  filter: AuditFilter & { before?: string; limit: number },
): Promise<{ entries: AuditEntryView[]; nextBefore: string | null }> {
  const where = conditions(tx, filter);
  if (filter.before) where.push(lt(auditLog.id, Number(filter.before)));
  const page = await entries(tx, where, filter.limit + 1);
  const more = page.length > filter.limit;
  const shown = more ? page.slice(0, filter.limit) : page;
  return { entries: shown, nextBefore: more ? shown[shown.length - 1]!.entryId : null };
}

/** Every entry the filter matches, up to EXPORT_MAX, and an audit entry saying who took them and how many (ADM26). */
export async function exportAudit(tx: TenantTx, filter: AuditFilter): Promise<{ entries: AuditEntryView[]; truncated: boolean }> {
  const found = await entries(tx, conditions(tx, filter), EXPORT_MAX + 1);
  const truncated = found.length > EXPORT_MAX;
  const shown = truncated ? found.slice(0, EXPORT_MAX) : found;
  await audit(tx, {
    action: 'audit.exported',
    zone: 'platform',
    // The record is the tenant's log as a whole; the details say which part was taken.
    recordTable: 'platform.audit_log',
    recordId: tx.context.tenantId,
    details: {
      newestEntryId: shown[0]?.entryId ?? null,
      count: shown.length,
      truncated,
      from: filter.from ?? null,
      to: filter.to ?? null,
      action: filter.action ?? null,
      zone: filter.zone ?? null,
      actorId: filter.actorId ?? null,
      recordTable: filter.recordTable ?? null,
      recordId: filter.recordId ?? null,
    },
  });
  return { entries: shown, truncated };
}
