import { and, asc, eq, isNull } from 'drizzle-orm';
import { blockRules, products } from '../../db/schema/index.js';
import type { BlockRuleMatch, ProductKind, ProductStatus, Schedule, Storage } from '../../db/schema/values.js';
import type { DbTx, TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { blockOf, normaliseArtg, type RuleForCheck } from './blocks.js';
import type { Product, ProductChange, ProductInput } from './catalogue.schemas.js';

/**
 * A tenant's products (docs/decisions/catalogue.md CAT1, CAT4, CAT5) and
 * the check every module makes before a product is prescribed, ordered or
 * charged (CAT3). Medora's block rules are read fresh each time, so a new
 * one stops existing products at once.
 */

type ProductRow = typeof products.$inferSelect;
type RuleRow = typeof blockRules.$inferSelect;

const RECORD = 'operational.products' as const;

const toRuleForCheck = (row: RuleRow): RuleForCheck => ({
  id: row.id,
  match: row.match as BlockRuleMatch,
  value: row.value,
  reason: row.reason,
  effectiveFrom: row.effectiveFrom,
});

/** Medora's rules in force or announced, oldest first. Retired ones are kept for the record and never apply. */
export async function currentRules(db: DbTx): Promise<RuleRow[]> {
  return db.select().from(blockRules).where(isNull(blockRules.retiredAt)).orderBy(asc(blockRules.effectiveFrom), asc(blockRules.addedAt));
}

const toProduct = (row: ProductRow, rules: readonly RuleForCheck[]): Product => ({
  productId: row.id,
  name: row.name,
  kind: row.kind as ProductKind,
  schedule: row.schedule as Schedule | null,
  artgNumber: row.artgNumber,
  compounded: row.compounded,
  strength: row.strength,
  form: row.form,
  packSize: row.packSize,
  storage: row.storage as Storage,
  priceCents: row.priceCents,
  gstFree: row.gstFree,
  status: row.status as ProductStatus,
  blocked: blockOf({ ...row, schedule: row.schedule as Schedule | null }, rules),
  updatedAt: row.updatedAt.toISOString(),
});

async function rulesForCheck(tx: TenantTx): Promise<RuleForCheck[]> {
  return (await currentRules(tx.db)).map(toRuleForCheck);
}

/** Every product in the tenant, archived ones too, each with whether it is blocked now. */
export async function listProducts(tx: TenantTx): Promise<Product[]> {
  const rows = await tx.db.select().from(products).where(eq(products.tenantId, tx.context.tenantId)).orderBy(asc(products.name));
  const rules = await rulesForCheck(tx);
  return rows.map((row) => toProduct(row, rules));
}

async function findProduct(tx: TenantTx, productId: string, lock = false): Promise<ProductRow> {
  const query = tx.db.select().from(products).where(and(eq(products.tenantId, tx.context.tenantId), eq(products.id, productId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Product');
  return row;
}

/**
 * One product, with whether it is blocked now (CAT3). NotFoundError when it
 * isn't this tenant's. Orders and billing read a product through this, and
 * refuse it when `blocked` is set or it is archived, or call
 * assertProductSuppliable, which does both.
 */
export async function getProduct(tx: TenantTx, productId: string): Promise<Product> {
  return toProduct(await findProduct(tx, productId), await rulesForCheck(tx));
}

/** The product, when it may be prescribed, ordered or charged now (CAT3); a 409 saying why when it may not. */
export async function assertProductSuppliable(tx: TenantTx, productId: string): Promise<Product> {
  const product = await getProduct(tx, productId);
  if (product.status === 'archived') throw new BusinessRuleError(`${product.name} is archived, so it can't be supplied`, 'product_archived');
  if (product.blocked) {
    const by = product.blocked.code === 'platform_rule' ? 'Medora has blocked' : 'Your tenant has blocked';
    throw new BusinessRuleError(`${by} ${product.name}: ${product.blocked.reason}`, 'product_blocked');
  }
  return product;
}

interface Identity {
  kind: ProductKind;
  schedule: Schedule | null;
  artgNumber: string | null;
  compounded: boolean;
}

/** CAT1: a medicine says what it is (an ARTG number, or compounded); only a medicine has a schedule or the compounded mark. */
function assertIdentity(identity: Identity): void {
  if (identity.artgNumber !== null && !/^[0-9]{3,8}$/.test(identity.artgNumber)) {
    throw new BadRequestError('An ARTG number is 3 to 8 digits', 'artg_invalid');
  }
  if (identity.kind === 'medicine') {
    if (identity.artgNumber === null && !identity.compounded) {
      throw new BadRequestError('A medicine needs its ARTG number, or to be marked compounded', 'medicine_identity_required');
    }
    return;
  }
  if (identity.schedule !== null || identity.compounded) {
    throw new BadRequestError('Only a medicine has a schedule or is compounded', 'not_a_medicine');
  }
}

export async function createProduct(tx: TenantTx, input: ProductInput): Promise<Product> {
  const identity: Identity = {
    kind: input.kind,
    schedule: input.schedule ?? null,
    artgNumber: normaliseArtg(input.artgNumber),
    compounded: input.compounded ?? false,
  };
  assertIdentity(identity);
  const [row] = await tx.db
    .insert(products)
    .values({
      tenantId: tx.context.tenantId,
      name: input.name,
      ...identity,
      strength: input.strength ?? null,
      form: input.form ?? null,
      packSize: input.packSize ?? null,
      storage: input.storage ?? 'room',
      priceCents: input.priceCents,
      gstFree: input.gstFree,
    })
    .returning();
  const record = { recordTable: RECORD, recordId: row!.id } as const;
  const facts = { kind: identity.kind, schedule: identity.schedule, compounded: identity.compounded, priceCents: input.priceCents };
  await audit(tx, { action: 'product.created', zone: 'operational', ...record, details: facts });
  await emitEvent(tx, { type: 'product.created', ...record, payload: facts });
  return toProduct(row!, await rulesForCheck(tx));
}

const pick = <T>(next: T | undefined, before: T): T => (next === undefined ? before : next);

export async function changeProduct(tx: TenantTx, productId: string, change: ProductChange): Promise<Product> {
  const before = await findProduct(tx, productId, true);
  const identity: Identity = {
    kind: pick(change.kind, before.kind as ProductKind),
    schedule: pick(change.schedule, before.schedule as Schedule | null),
    artgNumber: change.artgNumber === undefined ? before.artgNumber : normaliseArtg(change.artgNumber),
    compounded: pick(change.compounded, before.compounded),
  };
  assertIdentity(identity);
  const [row] = await tx.db
    .update(products)
    .set({
      name: pick(change.name, before.name),
      ...identity,
      strength: pick(change.strength, before.strength),
      form: pick(change.form, before.form),
      packSize: pick(change.packSize, before.packSize),
      storage: pick(change.storage, before.storage),
      priceCents: pick(change.priceCents, before.priceCents),
      gstFree: pick(change.gstFree, before.gstFree),
      updatedAt: new Date(),
    })
    .where(and(eq(products.tenantId, tx.context.tenantId), eq(products.id, productId)))
    .returning();
  const record = { recordTable: RECORD, recordId: productId } as const;
  const changed = Object.keys(change).sort().join(',');
  // CAT5: a price change says from what to what, since few people may make one.
  const facts = { changed, priceBefore: before.priceCents, priceAfter: row!.priceCents };
  await audit(tx, { action: 'product.changed', zone: 'operational', ...record, details: facts });
  await emitEvent(tx, { type: 'product.changed', ...record, payload: facts });
  return toProduct(row!, await rulesForCheck(tx));
}

/** Archive a product the tenant no longer sells, or bring it back (CAT1). Nothing is deleted. */
export async function setProductStatus(tx: TenantTx, productId: string, status: ProductStatus): Promise<Product> {
  const before = await findProduct(tx, productId, true);
  if (before.status !== status) {
    await tx.db
      .update(products)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(products.tenantId, tx.context.tenantId), eq(products.id, productId)));
    const record = { recordTable: RECORD, recordId: productId } as const;
    const facts = { from: before.status, to: status };
    await audit(tx, { action: 'product.status_changed', zone: 'operational', ...record, details: facts });
    await emitEvent(tx, { type: 'product.status_changed', ...record, payload: facts });
  }
  return getProduct(tx, productId);
}

/** The tenant's own block, with its reason (CAT4). It adds to Medora's rules and never lifts one. */
export async function blockProduct(tx: TenantTx, productId: string, reason: string): Promise<Product> {
  await findProduct(tx, productId, true);
  await tx.db
    .update(products)
    .set({ blockedReason: reason, updatedAt: new Date() })
    .where(and(eq(products.tenantId, tx.context.tenantId), eq(products.id, productId)));
  const record = { recordTable: RECORD, recordId: productId } as const;
  await audit(tx, { action: 'product.blocked', zone: 'operational', ...record });
  await emitEvent(tx, { type: 'product.blocked', ...record });
  return getProduct(tx, productId);
}

/** Lift the tenant's own block. A matching Medora rule still applies, and the reply says so in `blocked`. */
export async function unblockProduct(tx: TenantTx, productId: string): Promise<Product> {
  const before = await findProduct(tx, productId, true);
  if (before.blockedReason === null) return getProduct(tx, productId);
  await tx.db
    .update(products)
    .set({ blockedReason: null, updatedAt: new Date() })
    .where(and(eq(products.tenantId, tx.context.tenantId), eq(products.id, productId)));
  const record = { recordTable: RECORD, recordId: productId } as const;
  await audit(tx, { action: 'product.unblocked', zone: 'operational', ...record });
  await emitEvent(tx, { type: 'product.unblocked', ...record });
  return getProduct(tx, productId);
}
