import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { breakGlass, users } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { BREAK_GLASS_MINUTES } from '../../lib/permissions.js';
import type { TenantAccess } from '../../plugins/auth.js';
import { needsBreakGlassFor } from './access.js';

/**
 * Break-glass (docs/decisions/admin.md ADM3): someone whose role holds
 * clinical permissions it can't use on its own (the owner) states a reason
 * and gets them for 60 minutes. Each one is listed for review by someone
 * holding `break_glass:review`. The reason stays in its row, never in the
 * audit details, because people sometimes write a patient into it.
 */
export interface BreakGlassRecord {
  breakGlassId: string;
  membershipId: string;
  userId: string;
  email: string;
  reason: string;
  openedAt: string;
  endsAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

const columns = {
  breakGlassId: breakGlass.id,
  membershipId: breakGlass.membershipId,
  userId: breakGlass.userId,
  email: users.email,
  reason: breakGlass.reason,
  openedAt: breakGlass.openedAt,
  endsAt: breakGlass.endsAt,
  reviewedAt: breakGlass.reviewedAt,
  reviewNote: breakGlass.reviewNote,
};

type Row = Omit<BreakGlassRecord, 'openedAt' | 'endsAt' | 'reviewedAt'> & { openedAt: Date; endsAt: Date; reviewedAt: Date | null };

const toRecord = (row: Row): BreakGlassRecord => ({
  ...row,
  openedAt: row.openedAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
});

function personOf(tx: TenantTx): string {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person can use break-glass', 'person_only');
  return tx.context.actor.userId;
}

async function find(tx: TenantTx, id: string): Promise<BreakGlassRecord> {
  const [row] = await tx.db
    .select(columns)
    .from(breakGlass)
    .innerJoin(users, eq(users.id, breakGlass.userId))
    .where(and(eq(breakGlass.tenantId, tx.context.tenantId), eq(breakGlass.id, id)));
  if (!row) throw new NotFoundError('Break-glass');
  return toRecord(row);
}

export async function openBreakGlass(tx: TenantTx, access: TenantAccess, reason: string): Promise<BreakGlassRecord> {
  const userId = personOf(tx);
  if (!(await needsBreakGlassFor(tx, access))) {
    throw new BusinessRuleError('Your role already has the access it needs, or has no clinical access to open', 'break_glass_not_needed');
  }
  const [open] = await tx.db
    .select({ id: breakGlass.id })
    .from(breakGlass)
    .where(and(eq(breakGlass.tenantId, tx.context.tenantId), eq(breakGlass.membershipId, access.membershipId), gt(breakGlass.endsAt, sql`now()`)));
  if (open) return find(tx, open.id);
  const [row] = await tx.db
    .insert(breakGlass)
    .values({
      tenantId: tx.context.tenantId,
      membershipId: access.membershipId,
      userId,
      reason: reason.trim(),
      endsAt: sql`now() + make_interval(mins => ${BREAK_GLASS_MINUTES})`,
    })
    .returning({ id: breakGlass.id });
  const record = { recordTable: 'platform.break_glass', recordId: row!.id } as const;
  await audit(tx, { action: 'break_glass.opened', zone: 'platform', ...record, details: { minutes: BREAK_GLASS_MINUTES } });
  await emitEvent(tx, { type: 'break_glass.opened', ...record, payload: { userId, membershipId: access.membershipId } });
  return find(tx, row!.id);
}

/** End your own break-glass before its hour is up. */
export async function closeBreakGlass(tx: TenantTx, id: string): Promise<BreakGlassRecord> {
  const userId = personOf(tx);
  const current = await find(tx, id);
  if (current.userId !== userId) throw new ForbiddenError('You can only end your own break-glass');
  if (new Date(current.endsAt).getTime() <= Date.now()) return current;
  await tx.db
    .update(breakGlass)
    .set({ endsAt: sql`greatest(now(), ${breakGlass.openedAt} + interval '1 millisecond')` })
    .where(and(eq(breakGlass.tenantId, tx.context.tenantId), eq(breakGlass.id, id)));
  const record = { recordTable: 'platform.break_glass', recordId: id } as const;
  await audit(tx, { action: 'break_glass.closed', zone: 'platform', ...record });
  await emitEvent(tx, { type: 'break_glass.closed', ...record, payload: { userId } });
  return find(tx, id);
}

export async function listBreakGlass(tx: TenantTx, options: { unreviewedOnly: boolean }): Promise<BreakGlassRecord[]> {
  const rows = await tx.db
    .select(columns)
    .from(breakGlass)
    .innerJoin(users, eq(users.id, breakGlass.userId))
    .where(and(eq(breakGlass.tenantId, tx.context.tenantId), options.unreviewedOnly ? isNull(breakGlass.reviewedAt) : undefined))
    .orderBy(desc(breakGlass.openedAt))
    .limit(200);
  return rows.map(toRecord);
}

/** Mark one reviewed, with a note. Nobody reviews their own. */
export async function reviewBreakGlass(tx: TenantTx, id: string, note: string): Promise<BreakGlassRecord> {
  const userId = personOf(tx);
  const current = await find(tx, id);
  if (current.userId === userId) throw new ForbiddenError('Someone else reviews your break-glass', 'own_break_glass');
  if (current.reviewedAt) return current;
  await tx.db
    .update(breakGlass)
    .set({ reviewedAt: sql`now()`, reviewedBy: userId, reviewNote: note.trim() || null })
    .where(and(eq(breakGlass.tenantId, tx.context.tenantId), eq(breakGlass.id, id)));
  const record = { recordTable: 'platform.break_glass', recordId: id } as const;
  await audit(tx, { action: 'break_glass.reviewed', zone: 'platform', ...record });
  await emitEvent(tx, { type: 'break_glass.reviewed', ...record, payload: { userId: current.userId } });
  return find(tx, id);
}
