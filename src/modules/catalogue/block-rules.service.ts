import { eq, sql } from 'drizzle-orm';
import { blockRules } from '../../db/schema/index.js';
import type { BlockRuleMatch } from '../../db/schema/values.js';
import type { DbTx, PersonTx } from '../../db/tenant.js';
import { brokenConstraint } from '../../lib/database-errors.js';
import { BadRequestError, BusinessRuleError } from '../../lib/errors.js';
import { normaliseArtg } from './blocks.js';
import type { BlockRule, BlockRuleInput } from './catalogue.schemas.js';
import { currentRules } from './catalogue.service.js';

/**
 * Medora's block rules (docs/decisions/catalogue.md CAT2). Everyone signed
 * in reads them; platform staff add them through the reviewed function
 * platform.add_block_rule, which checks the flag again and writes the audit
 * entry. No route retires one.
 */

type RuleRow = typeof blockRules.$inferSelect;

const toRule = (row: RuleRow): BlockRule => ({
  ruleId: row.id,
  match: row.match as BlockRuleMatch,
  value: row.value,
  reason: row.reason,
  sourceUrl: row.sourceUrl,
  effectiveFrom: row.effectiveFrom.toISOString(),
  addedAt: row.addedAt.toISOString(),
});

export async function listBlockRules(tx: { db: DbTx }): Promise<BlockRule[]> {
  return (await currentRules(tx.db)).map(toRule);
}

/** The value a rule matches, tidied, or a 400 when it can't match anything. */
function ruleValue(match: BlockRuleMatch, typed: string | null | undefined): string | null {
  if (match === 'compounded') return null;
  if (match === 'schedule') {
    const schedule = (typed ?? '').toUpperCase();
    if (!/^S[2348]$/.test(schedule)) throw new BadRequestError('Choose a schedule: S2, S3, S4 or S8', 'rule_value_invalid');
    return schedule;
  }
  const artg = normaliseArtg(typed);
  if (!artg || !/^[0-9]{3,8}$/.test(artg)) throw new BadRequestError('An ARTG number is 3 to 8 digits', 'rule_value_invalid');
  return artg;
}

export async function addBlockRule(tx: PersonTx, input: BlockRuleInput, requestId: string): Promise<BlockRule> {
  const value = ruleValue(input.match, input.value);
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  const added = await tx.db
    .execute<{ rule_id: string }>(
      sql`select platform.add_block_rule(${input.match}, ${value}, ${input.reason}, ${input.sourceUrl ?? null}, ${effectiveFrom}, ${requestId}) as rule_id`,
    )
    .catch((error: unknown) => {
      if (brokenConstraint(error) === 'block_rules_current_key') throw new BusinessRuleError('Medora already blocks that', 'rule_exists');
      throw error;
    });
  const [row] = await tx.db.select().from(blockRules).where(eq(blockRules.id, added.rows[0]!.rule_id));
  return toRule(row!);
}
