import { z } from 'zod';
import { BLOCK_RULE_MATCHES, PRODUCT_KINDS, PRODUCT_STATUSES, SCHEDULES, STORAGE } from '../../db/schema/values.js';

/** Request and reply shapes for the catalogue and blocked items (docs/decisions/catalogue.md CAT1 to CAT6). */

const atLeastOne = (body: object) => Object.keys(body).length > 0;
const iso = z.iso.datetime();

/**
 * Why a product can't be prescribed, ordered or charged right now (CAT3):
 * one of Medora's block rules matches it, which no tenant can lift, or its
 * tenant blocked it. Medora's rule wins when both apply.
 */
export const productBlock = z.object({
  code: z.enum(['platform_rule', 'tenant_block']),
  reason: z.string(),
  /** The block rule that matched, for `platform_rule`. */
  ruleId: z.uuid().nullable(),
});
export type ProductBlock = z.infer<typeof productBlock>;

export const product = z.object({
  productId: z.uuid(),
  name: z.string(),
  kind: z.enum(PRODUCT_KINDS),
  schedule: z.enum(SCHEDULES).nullable(),
  artgNumber: z.string().nullable(),
  compounded: z.boolean(),
  strength: z.string().nullable(),
  form: z.string().nullable(),
  packSize: z.string().nullable(),
  storage: z.enum(STORAGE),
  priceCents: z.number().int(),
  gstFree: z.boolean(),
  status: z.enum(PRODUCT_STATUSES),
  blocked: productBlock.nullable(),
  updatedAt: iso,
});
export type Product = z.infer<typeof product>;
export const productsReply = z.object({ products: z.array(product) });

const name = z.string().trim().min(1).max(120);
const detail = z.string().trim().min(1).max(60).nullable();
/** As people type it from the ARTG entry; spaces are taken out. */
const artgNumber = z.string().max(20).nullable();
const priceCents = z.number().int().min(0).max(10_000_000);

const productFields = {
  name,
  kind: z.enum(PRODUCT_KINDS),
  schedule: z.enum(SCHEDULES).nullable().optional(),
  artgNumber: artgNumber.optional(),
  compounded: z.boolean().optional(),
  strength: detail.optional(),
  form: detail.optional(),
  packSize: detail.optional(),
  storage: z.enum(STORAGE).optional(),
  priceCents,
  gstFree: z.boolean(),
};

export const productInput = z.object(productFields).strict();
export type ProductInput = z.infer<typeof productInput>;

export const productChange = z
  .object({
    name: name.optional(),
    kind: productFields.kind.optional(),
    schedule: productFields.schedule,
    artgNumber: productFields.artgNumber,
    compounded: productFields.compounded,
    strength: productFields.strength,
    form: productFields.form,
    packSize: productFields.packSize,
    storage: productFields.storage,
    priceCents: priceCents.optional(),
    gstFree: z.boolean().optional(),
  })
  .strict()
  .refine(atLeastOne, { message: 'Send at least one field to change' });
export type ProductChange = z.infer<typeof productChange>;

export const productParams = z.object({ productId: z.uuid() });
/** Archive a product the tenant stops selling, or bring it back (CAT1). */
export const productStatusChange = z.object({ status: z.enum(PRODUCT_STATUSES) }).strict();
/** The tenant's own block (CAT4), with why, so whoever lifts it knows. */
export const productBlockInput = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

// Medora's block rules (CAT2).

export const blockRule = z.object({
  ruleId: z.uuid(),
  match: z.enum(BLOCK_RULE_MATCHES),
  /** The schedule or ARTG number matched; null for `compounded`. */
  value: z.string().nullable(),
  reason: z.string(),
  sourceUrl: z.string().nullable(),
  effectiveFrom: iso,
  addedAt: iso,
});
export type BlockRule = z.infer<typeof blockRule>;
export const blockRulesReply = z.object({ rules: z.array(blockRule) });

export const blockRuleInput = z
  .object({
    match: z.enum(BLOCK_RULE_MATCHES),
    value: z.string().trim().max(20).nullable().optional(),
    reason: z.string().trim().min(10).max(500),
    sourceUrl: z.url({ protocol: /^https$/ }).max(500).nullable().optional(),
    /** From when it applies; now when left out. A later time gives tenants notice. */
    effectiveFrom: iso.optional(),
  })
  .strict();
export type BlockRuleInput = z.infer<typeof blockRuleInput>;
