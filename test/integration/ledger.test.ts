import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { recordingLog } from '../support/log.js';
import { ledgerBalance, ledgerBalanceCheck, postEntry, reverseEntry, type LineInput } from '../../src/modules/ledger/index.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/** The ledger (ADR 0016, docs/decisions/billing.md BIL1 to BIL6). */
let app: App | undefined;
afterAll(async () => {
  await app?.close();
  await closeDatabase();
  await admin.end();
});

const tenant = await tenantWith('owner', 'finance', 'support');
const [owner, finance, support] = tenant.members as [(typeof tenant.members)[number], (typeof tenant.members)[number], (typeof tenant.members)[number]];
const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'test' });
const inTenant = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant(as(tenant.tenantId, finance.id), work);

/** A patient paying $110 through a payment account: receivable down, clearing up. */
function payment(patientId: string, paymentAccountId: string, cents = 11000): LineInput[] {
  return [
    { account: { kind: 'processor_clearing', paymentAccountId }, amountCents: cents },
    { account: { kind: 'patient_receivable', patientId }, amountCents: -cents },
  ];
}

const balance = (accountKind: string, ownerColumn: string, ownerId: string) =>
  admin
    .query(`select balance_cents from operational.ledger_accounts where tenant_id = $1 and kind = $2 and ${ownerColumn} = $3`, [tenant.tenantId, accountKind, ownerId])
    .then((r) => Number(r.rows[0]?.balance_cents));

describe('posting', () => {
  it('writes balanced lines, updates both balances and audits the posting', async () => {
    const patientId = randomUUID();
    const paymentAccountId = randomUUID();
    const posted = await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, paymentAccountId) }));
    expect(posted.replayed).toBe(false);
    expect(await balance('processor_clearing', 'payment_account_id', paymentAccountId)).toBe(11000);
    expect(await balance('patient_receivable', 'patient_id', patientId)).toBe(-11000);
    const { rows } = await admin.query(`select action, zone, details from platform.audit_log where record_id = $1`, [posted.entryId]);
    expect(rows).toEqual([{ action: 'ledger_entry.posted', zone: 'operational', details: { kind: 'payment_received', lines: 2 } }]);
  });

  it('posts a key once: the same lines again change nothing, different lines are refused', async () => {
    const patientId = randomUUID();
    const paymentAccountId = randomUUID();
    const key = `pay:${patientId}`;
    const first = await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: key, lines: payment(patientId, paymentAccountId) }));
    const again = await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: key, lines: payment(patientId, paymentAccountId) }));
    expect(again).toEqual({ entryId: first.entryId, replayed: true });
    await expect(
      inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: key, lines: payment(patientId, paymentAccountId, 500) })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await balance('processor_clearing', 'payment_account_id', paymentAccountId)).toBe(11000);
  });

  it('refuses lines that do not sum to zero, a single line and a zero line', async () => {
    const patientId = randomUUID();
    const unbalanced = [
      { account: { kind: 'patient_receivable', patientId }, amountCents: 100 },
      { account: { kind: 'revenue_consult' }, amountCents: -90 },
    ] as const;
    for (const lines of [unbalanced, unbalanced.slice(0, 1), [{ ...unbalanced[0], amountCents: 0 }, { ...unbalanced[1], amountCents: 0 }]]) {
      await expect(inTenant((tx) => postEntry(tx, { kind: 'invoice_issued', idempotencyKey: randomUUID(), lines }))).rejects.toMatchObject({ code: 'unbalanced_entry' });
    }
  });
});

describe('posting at the same moment (ADR 0016)', () => {
  it('lands every posting on a shared account, none lost', async () => {
    const paymentAccountId = randomUUID();
    const patients = Array.from({ length: 12 }, () => randomUUID());
    await Promise.all(
      patients.map((patientId) => inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, paymentAccountId, 100) }))),
    );
    expect(await balance('processor_clearing', 'payment_account_id', paymentAccountId)).toBe(1200);
    const ledger = await inTenant(async (tx) => {
      const { rows } = await tx.db.execute<{ id: string }>(sql`select id from operational.ledger_accounts where kind = 'processor_clearing' and payment_account_id = ${paymentAccountId}`);
      return ledgerBalance(tx, rows[0]!.id);
    });
    expect(ledger).toBe(1200);
  });

  it('writes one entry when the same key is posted twice at once', async () => {
    const patientId = randomUUID();
    const paymentAccountId = randomUUID();
    const post = () => inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, paymentAccountId) }));
    const results = await Promise.all([post(), post()]);
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await balance('processor_clearing', 'payment_account_id', paymentAccountId)).toBe(11000);
  });
});

describe('reversal', () => {
  it('undoes an entry with its lines negated, once', async () => {
    const patientId = randomUUID();
    const paymentAccountId = randomUUID();
    const posted = await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, paymentAccountId) }));
    const reversed = await inTenant((tx) => reverseEntry(tx, posted.entryId, `reverse:${posted.entryId}`));
    expect(await balance('processor_clearing', 'payment_account_id', paymentAccountId)).toBe(0);
    expect(await inTenant((tx) => reverseEntry(tx, posted.entryId, `reverse:${posted.entryId}`))).toEqual({ entryId: reversed.entryId, replayed: true });
    await expect(inTenant((tx) => reverseEntry(tx, posted.entryId, 'another key'))).rejects.toMatchObject({ code: 'already_reversed' });
    await expect(inTenant((tx) => reverseEntry(tx, reversed.entryId, 'reverse the reversal'))).rejects.toMatchObject({ code: 'reversal_of_reversal' });
  });
});

describe('the database keeps the ledger whole', () => {
  it('refuses to commit an entry whose lines do not balance, even for the owner', async () => {
    const client = await admin.connect();
    try {
      await client.query('begin');
      const entry = await client.query(`insert into operational.ledger_entries (tenant_id, kind, idempotency_key) values ($1, 'invoice_issued', $2) returning id`, [tenant.tenantId, randomUUID()]);
      const account = await client.query(`insert into operational.ledger_accounts (tenant_id, kind) values ($1, 'revenue_program') on conflict do nothing returning id`, [tenant.tenantId]);
      const accountId = account.rows[0]?.id ?? (await client.query(`select id from operational.ledger_accounts where tenant_id = $1 and kind = 'revenue_program'`, [tenant.tenantId])).rows[0].id;
      await client.query(`insert into operational.ledger_lines (tenant_id, entry_id, account_id, amount_cents) values ($1, $2, $3, 500)`, [tenant.tenantId, entry.rows[0].id, accountId]);
      await expect(client.query('commit')).rejects.toThrow(/does not balance/);
    } finally {
      client.release();
    }
  });

  it('refuses to change or delete a line, even for the owner', async () => {
    const patientId = randomUUID();
    const posted = await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, randomUUID()) }));
    await expect(admin.query(`update operational.ledger_lines set amount_cents = 1 where entry_id = $1`, [posted.entryId])).rejects.toThrow(/append-only/);
    await expect(admin.query(`delete from operational.ledger_entries where id = $1`, [posted.entryId])).rejects.toThrow(/append-only/);
  });
});

describe('tenancy (ADR 0006)', () => {
  it("never shows or touches another tenant's ledger", async () => {
    const other = await tenantWith('owner');
    const patientId = randomUUID();
    const posted = await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, randomUUID()) }));
    const seen = await withTenant(as(other.tenantId, other.members[0]!.id), async (tx) => ({
      entries: (await tx.db.execute(sql`select id from operational.ledger_entries`)).rows,
      lines: (await tx.db.execute(sql`select id from operational.ledger_lines`)).rows,
      accounts: (await tx.db.execute(sql`select id from operational.ledger_accounts`)).rows,
    }));
    expect(seen).toEqual({ entries: [], lines: [], accounts: [] });
    await expect(withTenant(as(other.tenantId, other.members[0]!.id), (tx) => reverseEntry(tx, posted.entryId, 'steal'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it("can't point a line at another tenant's account", async () => {
    const other = await tenantWith('owner');
    const { rows } = await admin.query(`insert into operational.ledger_accounts (tenant_id, kind) values ($1, 'revenue_consult') returning id`, [other.tenantId]);
    await expect(
      inTenant(async (tx) => {
        const entry = await tx.db.execute<{ id: string }>(sql`insert into operational.ledger_entries (tenant_id, kind, idempotency_key) values (${tenant.tenantId}, 'invoice_issued', ${randomUUID()}) returning id`);
        await tx.db.execute(sql`insert into operational.ledger_lines (tenant_id, entry_id, account_id, amount_cents) values (${tenant.tenantId}, ${entry.rows[0]!.id}, ${rows[0].id}, 5)`);
      }),
    ).rejects.toThrow();
  });
});

describe('the nightly balance check (BIL2)', () => {
  it('reports an account whose cached balance differs from its lines, and changes nothing', async () => {
    const patientId = randomUUID();
    await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, randomUUID()) }));
    await admin.query(`update operational.ledger_accounts set balance_cents = balance_cents + 1 where tenant_id = $1 and patient_id = $2`, [tenant.tenantId, patientId]);
    const log = recordingLog();
    await expect(ledgerBalanceCheck.run({ name: ledgerBalanceCheck.name, log })).rejects.toThrow(/differ from their lines/);
    expect(log.lines.find((line) => line.message === 'ledger balance differs from its lines')?.details).toMatchObject({ tenantId: tenant.tenantId, cachedCents: -10999, ledgerCents: -11000 });
    expect(await balance('patient_receivable', 'patient_id', patientId)).toBe(-10999);
    await admin.query(`update operational.ledger_accounts set balance_cents = balance_cents - 1 where tenant_id = $1 and patient_id = $2`, [tenant.tenantId, patientId]);
  });
});

describe('routes', () => {
  it('shows balances and entries to finance and the owner, and to nobody else', async () => {
    app = await testApp();
    const patientId = randomUUID();
    await inTenant((tx) => postEntry(tx, { kind: 'payment_received', idempotencyKey: `pay:${patientId}`, lines: payment(patientId, randomUUID()) }));
    const list = await app.inject({ method: 'GET', url: '/v1/ledger/accounts', headers: headers(await signIn(finance.email), tenant.tenantId) });
    expect(list.statusCode).toBe(200);
    const account = list.json().accounts.find((a: { patientId: string | null }) => a.patientId === patientId);
    expect(account).toMatchObject({ kind: 'patient_receivable', balanceCents: -11000 });
    const entries = await app.inject({ method: 'GET', url: `/v1/ledger/accounts/${account.accountId}/entries`, headers: headers(await signIn(owner.email), tenant.tenantId) });
    expect(entries.json().entries[0]).toMatchObject({ kind: 'payment_received', lines: expect.arrayContaining([expect.objectContaining({ accountKind: 'processor_clearing', amountCents: 11000 })]) });
    const refused = await app.inject({ method: 'GET', url: '/v1/ledger/accounts', headers: headers(await signIn(support.email), tenant.tenantId) });
    expect(refused.statusCode).toBe(403);
  });
});
