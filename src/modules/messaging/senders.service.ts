import { and, asc, eq, sql } from 'drizzle-orm';
import { senders } from '../../db/schema/index.js';
import type { SenderChannel, SenderPurpose } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getBrand } from '../brands/index.js';
import { normaliseEmail, normaliseSmsSender } from './addresses.js';

/** Each brand's addresses (docs/decisions/messaging.md CRM5). */

export interface Sender {
  senderId: string;
  brandId: string;
  channel: SenderChannel;
  purpose: SenderPurpose;
  address: string;
  updatedAt: Date;
}

const columns = {
  senderId: senders.id,
  brandId: senders.brandId,
  channel: senders.channel,
  purpose: senders.purpose,
  address: senders.address,
  updatedAt: senders.updatedAt,
};

type Row = {
  senderId: string;
  brandId: string;
  channel: string;
  purpose: string;
  address: string;
  updatedAt: Date;
};
const toSender = (row: Row): Sender => ({
  ...row,
  channel: row.channel as SenderChannel,
  purpose: row.purpose as SenderPurpose,
});

export async function listSenders(tx: TenantTx): Promise<Sender[]> {
  const rows = await tx.db.select(columns).from(senders).where(eq(senders.tenantId, tx.context.tenantId)).orderBy(asc(senders.brandId), asc(senders.channel), asc(senders.purpose));
  return rows.map(toSender);
}

export function normaliseSenderAddress(channel: SenderChannel, value: string): string {
  const address = channel === 'email' ? normaliseEmail(value) : normaliseSmsSender(value);
  if (!address) throw new BadRequestError(channel === 'email' ? 'Enter an email address' : 'Enter an Australian number, such as +61 4XX XXX XXX', 'address_invalid');
  return address;
}

export async function setSender(
  tx: TenantTx,
  input: {
    brandId: string;
    channel: SenderChannel;
    purpose: SenderPurpose;
    address: string;
  },
): Promise<Sender> {
  const { actor, tenantId } = tx.context;
  if (actor.type !== 'person') throw new ForbiddenError();
  await getBrand(tx, input.brandId);
  const address = normaliseSenderAddress(input.channel, input.address);
  const [row] = await tx.db
    .insert(senders)
    .values({
      tenantId,
      brandId: input.brandId,
      channel: input.channel,
      purpose: input.purpose,
      address,
      updatedByUserId: actor.userId,
    })
    .onConflictDoUpdate({
      target: [senders.tenantId, senders.brandId, senders.channel, senders.purpose],
      set: { address, updatedByUserId: actor.userId, updatedAt: sql`now()` },
    })
    .returning(columns);
  if (!row) throw new Error('sender upsert returned nothing');
  await audit(tx, {
    action: 'sender.set',
    zone: 'operational',
    recordTable: 'operational.senders',
    recordId: row.senderId,
    details: {
      brandId: input.brandId,
      channel: input.channel,
      purpose: input.purpose,
    },
  });
  return toSender(row);
}

export async function removeSender(tx: TenantTx, senderId: string): Promise<void> {
  const [row] = await tx.db
    .delete(senders)
    .where(and(eq(senders.tenantId, tx.context.tenantId), eq(senders.id, senderId)))
    .returning({
      brandId: senders.brandId,
      channel: senders.channel,
      purpose: senders.purpose,
    });
  if (!row) throw new NotFoundError('Sender');
  await audit(tx, {
    action: 'sender.removed',
    zone: 'operational',
    recordTable: 'operational.senders',
    recordId: senderId,
    details: row,
  });
}

/** The address a brand sends from on a channel, or null when none is set. */
export async function senderAddress(tx: TenantTx, brandId: string, channel: SenderChannel, purpose: SenderPurpose = 'service'): Promise<string | null> {
  const [row] = await tx.db
    .select({ address: senders.address })
    .from(senders)
    .where(and(eq(senders.tenantId, tx.context.tenantId), eq(senders.brandId, brandId), eq(senders.channel, channel), eq(senders.purpose, purpose)));
  return row?.address ?? null;
}

/** Which brand an inbound message was sent to, by the address it arrived at. */
export async function senderByAddress(tx: TenantTx, channel: SenderChannel, address: string): Promise<{ brandId: string; purpose: SenderPurpose } | null> {
  const normal = channel === 'email' ? normaliseEmail(address) : normaliseSmsSender(address);
  if (!normal) return null;
  const [row] = await tx.db
    .select({ brandId: senders.brandId, purpose: senders.purpose })
    .from(senders)
    .where(and(eq(senders.tenantId, tx.context.tenantId), eq(senders.channel, channel), eq(senders.address, normal)));
  return row ? { brandId: row.brandId, purpose: row.purpose as SenderPurpose } : null;
}
