import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAFETY_REPLIES, screenMessage } from '../../src/modules/agents/runtime/safety-screen.js';

/** The safety cases pass at 100% (docs/decisions/agents.md AGT10). */
const { cases } = JSON.parse(readFileSync('evals/safety.json', 'utf8')) as { cases: { text: string; expect: string | null }[] };

describe('the safety screen (AGT11)', () => {
  it('has cases for every outcome', () => {
    expect(new Set(cases.map((c) => c.expect))).toEqual(new Set(['emergency', 'self_harm', 'patient_asked', null]));
  });

  it.each(cases)('$text -> $expect', ({ text, expect: reason }) => {
    expect(screenMessage(text)?.reason ?? null).toBe(reason);
  });

  it('gives the fixed words, with 000 and Lifeline', () => {
    expect(screenMessage('I want to die')?.reply).toBe(SAFETY_REPLIES.self_harm);
    expect(SAFETY_REPLIES.self_harm).toContain('13 11 14');
    expect(SAFETY_REPLIES.emergency).toContain('000');
  });
});
