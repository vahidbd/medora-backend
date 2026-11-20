import { asc, eq, sql } from 'drizzle-orm';
import { consoleUrl } from '../../config/env.js';
import { paymentAccounts } from '../../db/schema/index.js';
import type { PaymentAccountStatus, Processor } from '../../db/schema/values.js';
import { type TenantContext, type TenantTx, withTenant } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { ProcessorAccountState } from './processor.js';
import { paymentProcessor } from './processors.js';

/**
 * Payment accounts (ADR 0037, docs/decisions/billing.md BIL8 to BIL12): a
 * tenant's own account at a processor. Changes lock every payment account of
 * the tenant in id order first, so two staff making different accounts the
 * default at once can't deadlock or leave two defaults.
 */

export interface PaymentAccount {
  paymentAccountId: string;
  processor: Processor;
  companyId: string;
  name: string;
  status: PaymentAccountStatus;
  processorAccountId: string | null;
  chargesEnabled: boolean;
  isDefault: boolean;
  activatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

type Row = typeof paymentAccounts.$inferSelect;

const TABLE = 'operational.payment_accounts';

function view(row: Row): PaymentAccount {
  return {
    paymentAccountId: row.id,
    processor: row.processor as Processor,
    companyId: row.companyId,
    name: row.name,
    status: row.status as PaymentAccountStatus,
    processorAccountId: row.processorAccountId,
    chargesEnabled: row.chargesEnabled,
    isDefault: row.isDefault,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function record(tx: TenantTx, action: string, id: string, details: Record<string, string | boolean | null> = {}): Promise<void> {
  const name = `payment_account.${action}` as const;
  await audit(tx, { action: name, zone: 'operational', recordTable: TABLE, recordId: id, details });
  await emitEvent(tx, { type: name, recordTable: TABLE, recordId: id, payload: details });
}

export async function listPaymentAccounts(tx: TenantTx): Promise<PaymentAccount[]> {
  const rows = await tx.db.select().from(paymentAccounts).orderBy(asc(paymentAccounts.createdAt), asc(paymentAccounts.id));
  return rows.map(view);
}

export async function getPaymentAccount(tx: TenantTx, id: string): Promise<PaymentAccount> {
  const [row] = await tx.db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id));
  if (!row) throw new NotFoundError('Payment account');
  return view(row);
}

/** Every payment account of the tenant, locked in id order; the one asked for must be among them. */
async function lockForChange(tx: TenantTx, id: string): Promise<{ target: Row; all: Row[] }> {
  const all = await tx.db.select().from(paymentAccounts).orderBy(asc(paymentAccounts.id)).for('update');
  const target = all.find((row) => row.id === id);
  if (!target) throw new NotFoundError('Payment account');
  return { target, all };
}

type Changes = { [K in keyof typeof paymentAccounts.$inferInsert]?: (typeof paymentAccounts.$inferInsert)[K] | ReturnType<typeof sql> };

async function update(tx: TenantTx, id: string, values: Changes): Promise<void> {
  await tx.db.update(paymentAccounts).set({ ...values, updatedAt: sql`now()` }).where(eq(paymentAccounts.id, id));
}

export async function createPaymentAccount(tx: TenantTx, input: { processor: Processor; companyId: string; name: string }): Promise<PaymentAccount> {
  const [row] = await tx.db
    .insert(paymentAccounts)
    .values({ tenantId: tx.context.tenantId, processor: input.processor, companyId: input.companyId, name: input.name })
    .returning();
  await record(tx, 'created', row!.id, { processor: input.processor });
  return view(row!);
}

export interface PaymentAccountChange {
  name?: string;
  /** true closes it to new subscriptions; false reopens it. */
  closed?: boolean;
  isDefault?: true;
}

export async function changePaymentAccount(tx: TenantTx, id: string, change: PaymentAccountChange): Promise<PaymentAccount> {
  const { target, all } = await lockForChange(tx, id);
  if (change.name !== undefined && change.name !== target.name) {
    await update(tx, id, { name: change.name });
    await record(tx, 'renamed', id);
  }
  if (change.closed === true && target.status !== 'closed') {
    if (target.isDefault) throw new BusinessRuleError('Make another payment account the default before closing this one', 'default_payment_account');
    await update(tx, id, { status: 'closed', closedAt: sql`now()` });
    await record(tx, 'closed', id);
  }
  if (change.closed === false && target.status === 'closed') {
    // Back to where it was: active if the processor ever said it could take payments.
    await update(tx, id, { status: target.activatedAt ? 'active' : 'setting_up', closedAt: null });
    await record(tx, 'reopened', id);
  }
  if (change.isDefault && !target.isDefault) {
    const [now] = await tx.db.select({ status: paymentAccounts.status }).from(paymentAccounts).where(eq(paymentAccounts.id, id));
    if (now?.status !== 'active') throw new BusinessRuleError('Only an active payment account can be the default', 'payment_account_not_active');
    await makeDefault(tx, id, all);
  }
  return getPaymentAccount(tx, id);
}

async function makeDefault(tx: TenantTx, id: string, all: Row[]): Promise<void> {
  const previous = all.find((row) => row.isDefault && row.id !== id);
  if (previous) await update(tx, previous.id, { isDefault: false });
  await update(tx, id, { isDefault: true });
  await record(tx, 'made_default', id, { previousPaymentAccountId: previous?.id ?? null });
}

/** Record the processor's account id the first time the processor opens it (BIL10). */
export async function connectProcessorAccount(tx: TenantTx, id: string, processorAccountId: string): Promise<void> {
  const { target } = await lockForChange(tx, id);
  if (target.processorAccountId === processorAccountId) return;
  // The database refuses to change one that is already set.
  await update(tx, id, { processorAccountId });
  await record(tx, 'connected', id, { processor: target.processor });
}

/**
 * What the processor says about the account, from a refresh now and from its
 * events later. The first time it can take payments, the account becomes
 * active, and the tenant's default if it has none (BIL11).
 */
export async function applyProcessorState(tx: TenantTx, id: string, state: ProcessorAccountState): Promise<PaymentAccount> {
  const { target, all } = await lockForChange(tx, id);
  if (state.chargesEnabled !== target.chargesEnabled) {
    await update(tx, id, { chargesEnabled: state.chargesEnabled });
    await record(tx, 'processor_state_changed', id, { chargesEnabled: state.chargesEnabled });
  }
  if (state.chargesEnabled && target.status === 'setting_up') {
    await update(tx, id, { status: 'active', activatedAt: sql`now()` });
    await record(tx, 'activated', id);
    if (!all.some((row) => row.isDefault)) await makeDefault(tx, id, all);
  }
  return getPaymentAccount(tx, id);
}

/** Where the processor's onboarding pages send staff back to in the console. */
function consolePage(id: string, onboarding: 'returned' | 'expired'): string {
  return `${consoleUrl}/settings/payment-accounts/${id}?onboarding=${onboarding}`;
}

/**
 * A link to finish onboarding on the processor's pages. The processor
 * account is opened on the first call, after the commit that recorded who
 * asked, with the payment account's id as the idempotency key, so a retry or
 * a second click opens nothing new (ADR 0029).
 */
export async function startOnboarding(context: TenantContext, id: string): Promise<{ url: string; expiresAt: string }> {
  const account = await withTenant(context, async (tx) => {
    const found = await getPaymentAccount(tx, id);
    if (found.status === 'closed') throw new BusinessRuleError('Reopen this payment account first', 'payment_account_closed');
    await audit(tx, { action: 'payment_account.onboarding_started', zone: 'operational', recordTable: TABLE, recordId: id });
    return found;
  });
  const onboarding = paymentProcessor(account.processor).hostedOnboarding;
  if (!onboarding) throw new BusinessRuleError("This processor is connected with keys, not on its own pages", 'no_hosted_onboarding');

  let processorAccountId = account.processorAccountId;
  if (!processorAccountId) {
    ({ processorAccountId } = await onboarding.createAccount({ tenantId: context.tenantId, paymentAccountId: id }, `payment-account-open:${id}`));
    const opened = processorAccountId;
    await withTenant(context, (tx) => connectProcessorAccount(tx, id, opened));
  }
  const link = await onboarding.onboardingLink(
    { processorAccountId, returnUrl: consolePage(id, 'returned'), refreshUrl: consolePage(id, 'expired') },
    `payment-account-link:${id}:${context.requestId ?? 'none'}`,
  );
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

/** Ask the processor how the account stands now, and record it. */
export async function refreshPaymentAccount(context: TenantContext, id: string): Promise<PaymentAccount> {
  const account = await withTenant(context, (tx) => getPaymentAccount(tx, id));
  if (!account.processorAccountId) return account;
  const state = await paymentProcessor(account.processor).getAccount(account.processorAccountId);
  return withTenant(context, (tx) => applyProcessorState(tx, id, state));
}
