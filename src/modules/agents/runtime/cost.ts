/**
 * What a run cost, in whole AUD cents, rounded up (docs/decisions/agents.md
 * AGT6). Estimated from the tokens each reply reports and a price table kept
 * here, converted at a fixed rate; the AWS bill is the record. Update both
 * when Bedrock's prices or the exchange rate move by more than a few per cent.
 */
export const AUD_PER_USD = 1.55;

interface Price {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  'anthropic.claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'anthropic.claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Whole cents, rounded up. A model with no price (the stand-in) costs nothing. */
export function costCents(model: string, usage: Usage): number {
  const price = PRICES[model];
  if (!price) return 0;
  const usd =
    (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000;
  return Math.ceil(usd * AUD_PER_USD * 100);
}
