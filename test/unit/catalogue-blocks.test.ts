import { describe, expect, it } from 'vitest';
import { blockOf, normaliseArtg, type ProductForCheck, type RuleForCheck } from '../../src/modules/catalogue/blocks.js';

/** Whether a product is blocked (docs/decisions/catalogue.md CAT2 to CAT4). Made-up rules and products. */
const now = new Date('2026-11-20T00:00:00Z');
const rule = (match: RuleForCheck['match'], value: string | null, effectiveFrom = new Date('2026-01-01T00:00:00Z')): RuleForCheck => ({
  id: `rule-${match}-${value ?? 'any'}`,
  match,
  value,
  reason: `Made-up rule on ${match}`,
  effectiveFrom,
});
const medicine = (over: Partial<ProductForCheck> = {}): ProductForCheck => ({
  kind: 'medicine',
  schedule: 'S4',
  artgNumber: '123456',
  compounded: false,
  blockedReason: null,
  ...over,
});

describe('blockOf', () => {
  it('matches a schedule, an ARTG number or the compounded mark', () => {
    expect(blockOf(medicine({ schedule: 'S8' }), [rule('schedule', 'S8')], now)?.code).toBe('platform_rule');
    expect(blockOf(medicine(), [rule('schedule', 'S8')], now)).toBeNull();
    expect(blockOf(medicine(), [rule('artg_number', '123456')], now)?.ruleId).toBe('rule-artg_number-123456');
    expect(blockOf(medicine({ artgNumber: null, compounded: true }), [rule('compounded', null)], now)?.code).toBe('platform_rule');
    expect(blockOf(medicine(), [rule('compounded', null)], now)).toBeNull();
  });

  it("doesn't match a device with no schedule or ARTG number", () => {
    const device: ProductForCheck = { kind: 'device', schedule: null, artgNumber: null, compounded: false, blockedReason: null };
    expect(blockOf(device, [rule('schedule', 'S8'), rule('compounded', null)], now)).toBeNull();
  });

  it('ignores a rule until its effective time', () => {
    const later = rule('schedule', 'S4', new Date('2026-12-01T00:00:00Z'));
    expect(blockOf(medicine(), [later], now)).toBeNull();
    expect(blockOf(medicine(), [later], new Date('2026-12-01T00:00:00Z'))?.code).toBe('platform_rule');
  });

  it("puts Medora's rule before the tenant's own block, and shows the tenant's when no rule matches", () => {
    const blocked = medicine({ blockedReason: 'Out of stock for the season', schedule: 'S8' });
    expect(blockOf(blocked, [rule('schedule', 'S8')], now)).toMatchObject({ code: 'platform_rule', reason: 'Made-up rule on schedule' });
    expect(blockOf(blocked, [], now)).toEqual({ code: 'tenant_block', reason: 'Out of stock for the season', ruleId: null });
  });
});

describe('normaliseArtg', () => {
  it('keeps the digits as people copy them', () => {
    expect(normaliseArtg('ARTG 123 456')).toBe('123456');
    expect(normaliseArtg('123-456')).toBe('123456');
    expect(normaliseArtg('  ')).toBeNull();
    expect(normaliseArtg(null)).toBeNull();
    expect(normaliseArtg('12a')).toBe('12a');
  });
});
