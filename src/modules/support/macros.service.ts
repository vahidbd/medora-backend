import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { macros } from '../../db/schema/index.js';
import type { MacroStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { postgresError } from '../../lib/database-errors.js';

/**
 * Macros: saved replies with approved wording (docs/decisions/support.md
 * SUP10). Anyone who can reply sees and uses approved ones; support:manage
 * writes, approves (their own too) and archives them. Changing an approved
 * macro sends it back to draft. A macro is written for everyone, so it
 * holds no patient's details.
 */

const RECORD = 'operational.macros' as const;
type MacroRow = typeof macros.$inferSelect;

export interface MacroView {
  macroId: string;
  name: string;
  body: string;
  status: MacroStatus;
  approvedAt: string | null;
  updatedAt: string;
}

function view(row: MacroRow): MacroView {
  return {
    macroId: row.id,
    name: row.name,
    body: row.body,
    status: row.status as MacroStatus,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function personOf(tx: TenantTx): string {
  const { actor } = tx.context;
  if (actor.type !== 'person') throw new ForbiddenError('Only a staff member writes or approves a macro', 'person_only');
  return actor.userId;
}

async function load(tx: TenantTx, macroId: string): Promise<MacroRow> {
  const [row] = await tx.db
    .select()
    .from(macros)
    .where(and(eq(macros.tenantId, tx.context.tenantId), eq(macros.id, macroId), isNull(macros.archivedAt)))
    .for('update');
  if (!row) throw new NotFoundError('Macro');
  return row;
}

async function nameTaken<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = postgresError(error);
    if (pg?.code === '23505' && pg.message.includes('macros_tenant_name_key')) throw new BusinessRuleError('A macro already has that name', 'macro_name_taken');
    throw error;
  }
}

/** Approved macros for anyone who replies; every one, drafts too, for support:manage. */
export async function listMacros(tx: TenantTx, options: { includeDrafts: boolean }): Promise<MacroView[]> {
  const rows = await tx.db
    .select()
    .from(macros)
    .where(and(eq(macros.tenantId, tx.context.tenantId), isNull(macros.archivedAt), options.includeDrafts ? undefined : eq(macros.status, 'approved')))
    .orderBy(asc(sql`lower(${macros.name})`));
  return rows.map(view);
}

export async function createMacro(tx: TenantTx, input: { name: string; body: string }): Promise<MacroView> {
  const userId = personOf(tx);
  const [row] = await nameTaken(() =>
    tx.db
      .insert(macros)
      .values({
        tenantId: tx.context.tenantId,
        name: input.name,
        body: input.body,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning(),
  );
  if (!row) throw new Error('macro insert returned nothing');
  await audit(tx, {
    action: 'macro.created',
    zone: 'operational',
    recordTable: RECORD,
    recordId: row.id,
  });
  return view(row);
}

export async function updateMacro(tx: TenantTx, macroId: string, input: { name?: string | undefined; body?: string | undefined }): Promise<MacroView> {
  const userId = personOf(tx);
  const current = await load(tx, macroId);
  const wordingChanged = (input.body !== undefined && input.body !== current.body) || (input.name !== undefined && input.name !== current.name);
  if (!wordingChanged) return view(current);
  const [row] = await nameTaken(() =>
    tx.db
      .update(macros)
      .set({
        name: input.name ?? current.name,
        body: input.body ?? current.body,
        // New wording is unapproved wording (SUP10).
        status: 'draft',
        approvedByUserId: null,
        approvedAt: null,
        updatedByUserId: userId,
        updatedAt: sql`now()`,
      })
      .where(and(eq(macros.tenantId, tx.context.tenantId), eq(macros.id, macroId)))
      .returning(),
  );
  if (!row) throw new NotFoundError('Macro');
  await audit(tx, {
    action: 'macro.updated',
    zone: 'operational',
    recordTable: RECORD,
    recordId: row.id,
    details: { backToDraft: current.status === 'approved' },
  });
  return view(row);
}

export async function approveMacro(tx: TenantTx, macroId: string): Promise<MacroView> {
  const userId = personOf(tx);
  const current = await load(tx, macroId);
  if (current.status === 'approved') return view(current);
  const [row] = await tx.db
    .update(macros)
    .set({
      status: 'approved',
      approvedByUserId: userId,
      approvedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(macros.tenantId, tx.context.tenantId), eq(macros.id, macroId)))
    .returning();
  if (!row) throw new NotFoundError('Macro');
  await audit(tx, {
    action: 'macro.approved',
    zone: 'operational',
    recordTable: RECORD,
    recordId: row.id,
  });
  return view(row);
}

/** Archived macros are kept, since replies name the macro they started from. */
export async function archiveMacro(tx: TenantTx, macroId: string): Promise<void> {
  personOf(tx);
  await load(tx, macroId);
  await tx.db
    .update(macros)
    .set({ archivedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(macros.tenantId, tx.context.tenantId), eq(macros.id, macroId)));
  await audit(tx, {
    action: 'macro.archived',
    zone: 'operational',
    recordTable: RECORD,
    recordId: macroId,
  });
}
