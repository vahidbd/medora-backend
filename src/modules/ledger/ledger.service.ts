import { and, asc, eq } from 'drizzle-orm';
import { ledgerEntries, ledgerLines } from '../../db/schema/index.js';
import type { FeeKind, LedgerEntryKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { assertCents, sumCents } from '../../lib/money.js';
import { type AccountRef, accountId, addToBalance, lockAccounts } from './ledger.accounts.js';

/**
 * Posting to the ledger (ADR 0016, docs/decisions/billing.md BIL1 and BIL2).
 * One entry per money movement, its lines summing to zero, written once.
 * Posting the same idempotency key again returns the first entry and changes
 * nothing; the same key with different lines is refused.
 */
export interface LineInput {
  account: AccountRef;
  /** Debit positive, credit negative. */
  amountCents: number;
  feeKind?: FeeKind;
}

export interface EntryInput {
  kind: Exclude<LedgerEntryKind, 'reversal'>;
  /** Names the movement, e.g. `payment:<id>:received`. The same key never posts twice. */
  idempotencyKey: string;
  lines: readonly LineInput[];
  /** When the money moved, if not now (a processor's time). */
  occurredAt?: Date;
}

export interface PostedEntry {
  entryId: string;
  /** True when this key had already been posted and nothing new was written. */
  replayed: boolean;
}

function checkLines(lines: readonly LineInput[]): void {
  if (lines.length < 2) throw new BusinessRuleError('A ledger entry needs at least two lines', 'unbalanced_entry');
  for (const line of lines) {
    assertCents(line.amountCents);
    if (line.amountCents === 0) throw new BusinessRuleError('A ledger line needs an amount', 'unbalanced_entry');
  }
  if (sumCents(lines.map((line) => line.amountCents)) !== 0) throw new BusinessRuleError("A ledger entry's lines must sum to zero", 'unbalanced_entry');
}

interface ResolvedLine {
  accountId: string;
  amountCents: number;
  feeKind: string | null;
}

/** Lines as comparable text, ignoring order, so a replay can be told from a conflicting posting. */
function fingerprint(lines: readonly ResolvedLine[]): string {
  return lines
    .map((line) => `${line.accountId}|${line.amountCents}|${line.feeKind ?? ''}`)
    .sort()
    .join('\n');
}

async function writeEntry(
  tx: TenantTx,
  header: { kind: LedgerEntryKind; idempotencyKey: string; occurredAt?: Date; reversesEntryId?: string },
  lines: readonly ResolvedLine[],
): Promise<PostedEntry> {
  const { tenantId } = tx.context;
  // The header first: a concurrent posting with the same key waits here, then finds this one.
  const [inserted] = await tx.db
    .insert(ledgerEntries)
    .values({ tenantId, kind: header.kind, idempotencyKey: header.idempotencyKey, reversesEntryId: header.reversesEntryId ?? null, ...(header.occurredAt ? { occurredAt: header.occurredAt } : {}) })
    .onConflictDoNothing({ target: [ledgerEntries.tenantId, ledgerEntries.idempotencyKey] })
    .returning({ id: ledgerEntries.id });

  if (!inserted) {
    const [existing] = await tx.db
      .select({ id: ledgerEntries.id, kind: ledgerEntries.kind })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.idempotencyKey, header.idempotencyKey)));
    if (!existing) throw new Error('A ledger entry with this key was neither written nor found');
    const written = await tx.db
      .select({ accountId: ledgerLines.accountId, amountCents: ledgerLines.amountCents, feeKind: ledgerLines.feeKind })
      .from(ledgerLines)
      .where(and(eq(ledgerLines.tenantId, tenantId), eq(ledgerLines.entryId, existing.id)));
    if (existing.kind !== header.kind || fingerprint(written) !== fingerprint(lines)) {
      throw new BusinessRuleError('This ledger posting was already made with different amounts', 'idempotency_conflict');
    }
    return { entryId: existing.id, replayed: true };
  }

  const ids = [...new Set(lines.map((line) => line.accountId))];
  await lockAccounts(tx, ids);
  await tx.db.insert(ledgerLines).values(
    lines.map((line) => ({ tenantId, entryId: inserted.id, accountId: line.accountId, amountCents: line.amountCents, feeKind: line.feeKind })),
  );
  for (const id of ids) {
    await addToBalance(tx, id, sumCents(lines.filter((line) => line.accountId === id).map((line) => line.amountCents)));
  }
  await audit(tx, {
    action: 'ledger_entry.posted',
    zone: 'operational',
    recordTable: 'operational.ledger_entries',
    recordId: inserted.id,
    details: { kind: header.kind, lines: lines.length, ...(header.reversesEntryId ? { reverses: header.reversesEntryId } : {}) },
  });
  return { entryId: inserted.id, replayed: false };
}

export async function postEntry(tx: TenantTx, input: EntryInput): Promise<PostedEntry> {
  checkLines(input.lines);
  const lines: ResolvedLine[] = [];
  for (const line of input.lines) {
    lines.push({ accountId: await accountId(tx, line.account), amountCents: line.amountCents, feeKind: line.feeKind ?? null });
  }
  return writeEntry(tx, input, lines);
}

/** The entry posted under an idempotency key, or null when nothing was. */
export async function entryIdForKey(tx: TenantTx, idempotencyKey: string): Promise<string | null> {
  const [found] = await tx.db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tx.context.tenantId), eq(ledgerEntries.idempotencyKey, idempotencyKey)));
  return found?.id ?? null;
}

/**
 * Undo an entry with a new one whose lines are its lines negated (ADR 0016:
 * the ledger shows the mistake and its fix). An entry is reversed at most
 * once, and a reversal is never itself reversed: post the movement again.
 */
export async function reverseEntry(tx: TenantTx, entryId: string, idempotencyKey: string): Promise<PostedEntry> {
  const { tenantId } = tx.context;
  const [entry] = await tx.db
    .select({ id: ledgerEntries.id, kind: ledgerEntries.kind })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.id, entryId)));
  if (!entry) throw new NotFoundError('Ledger entry');
  if (entry.kind === 'reversal') throw new BusinessRuleError("A reversal can't be reversed. Post the movement again instead.", 'reversal_of_reversal');
  const [already] = await tx.db
    .select({ id: ledgerEntries.id, key: ledgerEntries.idempotencyKey })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.reversesEntryId, entryId)));
  if (already) {
    if (already.key === idempotencyKey) return { entryId: already.id, replayed: true };
    throw new BusinessRuleError('This ledger entry has already been reversed', 'already_reversed');
  }
  const original = await tx.db
    .select({ accountId: ledgerLines.accountId, amountCents: ledgerLines.amountCents, feeKind: ledgerLines.feeKind })
    .from(ledgerLines)
    .where(and(eq(ledgerLines.tenantId, tenantId), eq(ledgerLines.entryId, entryId)))
    .orderBy(asc(ledgerLines.id));
  return writeEntry(
    tx,
    { kind: 'reversal', idempotencyKey, reversesEntryId: entryId },
    original.map((line) => ({ accountId: line.accountId, amountCents: -line.amountCents, feeKind: line.feeKind })),
  );
}
