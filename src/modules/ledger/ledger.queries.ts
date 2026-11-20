import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ledgerAccounts, ledgerEntries, ledgerLines } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { NotFoundError } from '../../lib/errors.js';
import type { LedgerAccount, LedgerEntry } from './ledger.schemas.js';

/** Reading the ledger: accounts with their balances, and entries with their lines. */

type AccountRow = typeof ledgerAccounts.$inferSelect;

function toAccount(row: AccountRow): LedgerAccount {
  return {
    accountId: row.id,
    kind: row.kind as LedgerAccount['kind'],
    currency: row.currency as LedgerAccount['currency'],
    patientId: row.patientId,
    paymentAccountId: row.paymentAccountId,
    partnerPharmacyId: row.partnerPharmacyId,
    balanceCents: row.balanceCents,
  };
}

export async function listAccounts(tx: TenantTx): Promise<LedgerAccount[]> {
  const rows = await tx.db
    .select()
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tx.context.tenantId))
    .orderBy(ledgerAccounts.kind, ledgerAccounts.createdAt, ledgerAccounts.id);
  return rows.map(toAccount);
}

/** An account's balance worked out from its lines: the truth the cached balance is checked against (BIL2). */
export async function ledgerBalance(tx: TenantTx, accountId: string): Promise<number> {
  const [row] = await tx.db
    .select({ total: sql<string>`coalesce(sum(${ledgerLines.amountCents}), 0)` })
    .from(ledgerLines)
    .where(and(eq(ledgerLines.tenantId, tx.context.tenantId), eq(ledgerLines.accountId, accountId)));
  return Number(row?.total ?? 0);
}

/** The newest entries touching an account, with all their lines. */
export async function listEntries(tx: TenantTx, accountId: string, limit = 50): Promise<LedgerEntry[]> {
  const { tenantId } = tx.context;
  const [account] = await tx.db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, accountId)));
  if (!account) throw new NotFoundError('Ledger account');
  const entries = await tx.db
    .selectDistinct({ id: ledgerEntries.id, kind: ledgerEntries.kind, occurredAt: ledgerEntries.occurredAt, postedAt: ledgerEntries.postedAt, reversesEntryId: ledgerEntries.reversesEntryId })
    .from(ledgerEntries)
    .innerJoin(ledgerLines, and(eq(ledgerLines.tenantId, ledgerEntries.tenantId), eq(ledgerLines.entryId, ledgerEntries.id)))
    .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerLines.accountId, accountId)))
    .orderBy(desc(ledgerEntries.postedAt), desc(ledgerEntries.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  if (entries.length === 0) return [];
  const lines = await tx.db
    .select({ entryId: ledgerLines.entryId, accountId: ledgerLines.accountId, kind: ledgerAccounts.kind, amountCents: ledgerLines.amountCents, feeKind: ledgerLines.feeKind })
    .from(ledgerLines)
    .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.tenantId, ledgerLines.tenantId), eq(ledgerAccounts.id, ledgerLines.accountId)))
    .where(and(eq(ledgerLines.tenantId, tenantId), inArray(ledgerLines.entryId, entries.map((entry) => entry.id))))
    .orderBy(ledgerLines.id);
  return entries.map((entry) => ({
    entryId: entry.id,
    kind: entry.kind as LedgerEntry['kind'],
    occurredAt: entry.occurredAt.toISOString(),
    postedAt: entry.postedAt.toISOString(),
    reversesEntryId: entry.reversesEntryId,
    lines: lines
      .filter((line) => line.entryId === entry.id)
      .map((line) => ({ accountId: line.accountId, accountKind: line.kind as LedgerAccount['kind'], amountCents: line.amountCents, feeKind: line.feeKind as LedgerEntry['lines'][number]['feeKind'] })),
  }));
}

/** Accounts whose cached balance differs from their lines (BIL2). */
export async function balanceDrift(tx: TenantTx): Promise<{ accountId: string; cachedCents: number; ledgerCents: number }[]> {
  const result = await tx.db.execute<{ id: string; balance_cents: string; total: string }>(sql`
    select a.id, a.balance_cents, coalesce(sum(l.amount_cents), 0) as total
      from operational.ledger_accounts a
      left join operational.ledger_lines l on l.tenant_id = a.tenant_id and l.account_id = a.id
     where a.tenant_id = ${tx.context.tenantId}
     group by a.id, a.balance_cents
    having a.balance_cents <> coalesce(sum(l.amount_cents), 0)`);
  return result.rows.map((row) => ({ accountId: row.id, cachedCents: Number(row.balance_cents), ledgerCents: Number(row.total) }));
}
