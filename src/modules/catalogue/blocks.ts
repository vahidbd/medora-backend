import type { BlockRuleMatch, Schedule } from '../../db/schema/values.js';
import type { ProductBlock } from './catalogue.schemas.js';

/**
 * Whether a product is blocked, worked out when it is used (CAT3), so a
 * rule Medora adds today stops products made last year. Pure, so every
 * caller gets the same answer.
 */

export interface RuleForCheck {
  id: string;
  match: BlockRuleMatch;
  value: string | null;
  reason: string;
  effectiveFrom: Date;
}

export interface ProductForCheck {
  kind: string;
  schedule: Schedule | null;
  artgNumber: string | null;
  compounded: boolean;
  blockedReason: string | null;
}

export function ruleMatches(rule: RuleForCheck, product: ProductForCheck): boolean {
  switch (rule.match) {
    case 'schedule':
      return product.schedule !== null && product.schedule === rule.value;
    case 'artg_number':
      return product.artgNumber !== null && product.artgNumber === rule.value;
    case 'compounded':
      return product.compounded;
  }
}

/** Medora's matching rule first (no tenant can lift it), then the tenant's own block. Rules not yet in effect don't count. */
export function blockOf(product: ProductForCheck, rules: readonly RuleForCheck[], now = new Date()): ProductBlock | null {
  const rule = rules.find((candidate) => candidate.effectiveFrom <= now && ruleMatches(candidate, product));
  if (rule) return { code: 'platform_rule', reason: rule.reason, ruleId: rule.id };
  if (product.blockedReason) return { code: 'tenant_block', reason: product.blockedReason, ruleId: null };
  return null;
}

/** ARTG numbers as people copy them ("ARTG 123456", "123 456"): digits only, or null when there are none. */
export function normaliseArtg(typed: string | null | undefined): string | null {
  if (typed === null || typed === undefined) return null;
  const digits = typed.replace(/^\s*ARTG\s*/i, '').replace(/[\s-]/g, '');
  return digits === '' ? null : digits;
}
