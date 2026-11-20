import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { webhookInbox } from '../db/schema/index.js';
import type { WebhookProvider } from '../db/schema/values.js';
import { type TenantTx, withTenant } from '../db/tenant.js';
import { postgresError } from './database-errors.js';
import { AppError } from './errors.js';

/**
 * The one webhook inbox (ADR 0029, docs/decisions/webhooks.md). A provider's
 * route checks the signature, then calls receiveWebhook: the delivery is
 * stored in one transaction and processed in the next, by the handler its
 * module registered with onWebhook. The handler's work and the "processed"
 * mark commit together, so a delivery is processed once however often the
 * provider sends it.
 */

export interface WebhookDelivery {
  deliveryId: number;
  provider: WebhookProvider;
  providerEventId: string;
  kind: string;
  body: unknown;
  receivedAt: Date;
  /** How many times processing was tried before this one. */
  attempts: number;
}

export type WebhookHandler = (tx: TenantTx, delivery: WebhookDelivery) => Promise<void>;

export interface IncomingWebhook {
  provider: WebhookProvider;
  providerEventId: string;
  kind: string;
  body: unknown;
}

export type WebhookOutcome = 'processed' | 'failed' | 'skipped';

/** After this many failed tries a delivery waits for a person (WHK3). */
export const MAX_WEBHOOK_ATTEMPTS = 8;

const handlers = new Map<string, WebhookHandler>();
const keyOf = (provider: WebhookProvider, kind: string) => `${provider}:${kind}`;

/** Registers the handler for one provider and kind. A second registration is a mistake, so it stops the app starting. */
export function onWebhook(provider: WebhookProvider, kind: string, handler: WebhookHandler): void {
  const key = keyOf(provider, kind);
  if (handlers.get(key) === handler) return;
  if (handlers.has(key)) throw new Error(`A webhook handler for ${key} is already registered`);
  handlers.set(key, handler);
}

/** The system acts on a webhook, inside the tenant the webhook's address names. */
function systemContext(tenantId: string, requestId: string | null) {
  return { tenantId, actor: { type: 'system' as const }, requestId };
}

/**
 * Store a delivery whose signature has been checked, then process it.
 * A duplicate stores nothing; it is processed only if it hasn't been yet.
 */
export async function receiveWebhook(
  context: { tenantId: string; requestId: string | null },
  incoming: IncomingWebhook,
): Promise<{ deliveryId: number; duplicate: boolean; outcome: WebhookOutcome }> {
  const { deliveryId, duplicate } = await withTenant(systemContext(context.tenantId, context.requestId), (tx) => storeWebhook(tx, incoming));
  const outcome = await processWebhook(context, deliveryId);
  return { deliveryId, duplicate, outcome };
}

async function storeWebhook(tx: TenantTx, incoming: IncomingWebhook): Promise<{ deliveryId: number; duplicate: boolean }> {
  const [stored] = await tx.db
    .insert(webhookInbox)
    .values({
      tenantId: tx.context.tenantId,
      provider: incoming.provider,
      providerEventId: incoming.providerEventId,
      kind: incoming.kind,
      body: incoming.body ?? {},
      requestId: tx.context.requestId,
    })
    .onConflictDoNothing({ target: [webhookInbox.tenantId, webhookInbox.provider, webhookInbox.providerEventId] })
    .returning({ id: webhookInbox.id });
  if (stored) return { deliveryId: stored.id, duplicate: false };
  const [existing] = await tx.db
    .select({ id: webhookInbox.id })
    .from(webhookInbox)
    .where(
      and(
        eq(webhookInbox.tenantId, tx.context.tenantId),
        eq(webhookInbox.provider, incoming.provider),
        eq(webhookInbox.providerEventId, incoming.providerEventId),
      ),
    );
  if (!existing) throw new Error('A webhook delivery conflicted but could not be found');
  return { deliveryId: existing.id, duplicate: true };
}

/** A code safe for the inbox: never a message, which could quote the body. */
function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  const pg = postgresError(error);
  if (pg) return `postgres_${pg.code}`;
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Process one stored delivery. The row is locked, so two processors can't
 * run it at once; a processed row is skipped. A handler that throws rolls
 * its work back, and the row is marked failed with the error's code.
 */
export async function processWebhook(context: { tenantId: string; requestId: string | null }, deliveryId: number): Promise<WebhookOutcome> {
  const ctx = systemContext(context.tenantId, context.requestId);
  try {
    return await withTenant(ctx, async (tx) => {
      const [row] = await tx.db
        .select()
        .from(webhookInbox)
        .where(and(eq(webhookInbox.tenantId, ctx.tenantId), eq(webhookInbox.id, deliveryId), ne(webhookInbox.status, 'processed')))
        .for('update', { skipLocked: true });
      if (!row) return 'skipped';
      const handler = handlers.get(keyOf(row.provider as WebhookProvider, row.kind));
      // docs/decisions/webhooks.md WHK2: a kind whose module hasn't registered yet waits, untouched.
      if (!handler) return 'skipped';
      await handler(tx, {
        deliveryId: row.id,
        provider: row.provider as WebhookProvider,
        providerEventId: row.providerEventId,
        kind: row.kind,
        body: row.body,
        receivedAt: row.receivedAt,
        attempts: row.attempts,
      });
      await tx.db
        .update(webhookInbox)
        .set({ status: 'processed', attempts: sql`${webhookInbox.attempts} + 1`, lastError: null, processedAt: new Date() })
        .where(and(eq(webhookInbox.tenantId, ctx.tenantId), eq(webhookInbox.id, deliveryId)));
      return 'processed';
    });
  } catch (error) {
    await withTenant(ctx, (tx) =>
      tx.db
        .update(webhookInbox)
        .set({ status: 'failed', attempts: sql`${webhookInbox.attempts} + 1`, lastError: errorCode(error) })
        .where(and(eq(webhookInbox.tenantId, ctx.tenantId), eq(webhookInbox.id, deliveryId), ne(webhookInbox.status, 'processed'))),
    );
    return 'failed';
  }
}

/**
 * Retry what is waiting in one tenant, oldest first: received deliveries and
 * failed ones under MAX_WEBHOOK_ATTEMPTS. For the job runner (ADR 0029).
 */
export async function processPendingWebhooks(tenantId: string, options: { limit?: number } = {}): Promise<{ processed: number; failed: number }> {
  const pending = await withTenant(systemContext(tenantId, null), (tx) =>
    tx.db
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(
        and(
          eq(webhookInbox.tenantId, tenantId),
          inArray(webhookInbox.status, ['received', 'failed']),
          lt(webhookInbox.attempts, MAX_WEBHOOK_ATTEMPTS),
        ),
      )
      .orderBy(asc(webhookInbox.id))
      .limit(options.limit ?? 50),
  );
  const tally = { processed: 0, failed: 0 };
  for (const { id } of pending) {
    const outcome = await processWebhook({ tenantId, requestId: null }, id);
    if (outcome === 'processed') tally.processed += 1;
    if (outcome === 'failed') tally.failed += 1;
  }
  return tally;
}

/** Compares a provider's signature with the one we work out, in constant time (ADR 0030). */
export function signatureMatches(input: {
  algorithm: 'sha1' | 'sha256';
  secret: string;
  payload: string;
  signature: string;
  encoding: 'hex' | 'base64';
}): boolean {
  if (!input.secret || !input.signature) return false;
  const expected = createHmac(input.algorithm, input.secret).update(input.payload, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(input.signature, input.encoding);
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Inside a webhook routes' plugin scope: JSON and form bodies arrive as the
 * raw string, since a signature covers the bytes as sent. Parse after checking.
 */
export function acceptRawBodies(scope: FastifyInstance): void {
  scope.removeAllContentTypeParsers();
  // application/webhook+json is how the video server labels its JSON.
  for (const type of ['application/json', 'application/webhook+json', 'application/x-www-form-urlencoded']) {
    scope.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
  }
}
