import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AGENT_KINDS, type AgentKind } from '../../db/schema/values.js';

/**
 * Recorded eval results (docs/decisions/agents.md AGT10): one file per agent
 * in `evals/results/`, written by `npm run evals -- --record` against Claude
 * on Bedrock with staging credentials, and committed with the change it
 * tests. An agent can be switched on, and its runs run, only when the file
 * records a pass for the exact version that would run.
 */
export const evalResultSchema = z.object({
  agent: z.enum(AGENT_KINDS),
  version: z.string().regex(/^[0-9a-f]{16}$/),
  model: z.string(),
  passed: z.boolean(),
  cases: z.number().int().positive(),
  failed: z.array(z.string()),
  ranAt: z.iso.datetime(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;

export function resultsPath(agent: AgentKind, dir = env.AGENT_EVAL_RESULTS_DIR): string {
  return join(dir, `${agent.replace(/_/g, '-')}.json`);
}

/** The recorded result, or null when there is none or it doesn't parse. */
export function recordedEval(agent: AgentKind, dir = env.AGENT_EVAL_RESULTS_DIR): EvalResult | null {
  let text: string;
  try {
    text = readFileSync(resultsPath(agent, dir), 'utf8');
  } catch {
    return null;
  }
  const parsed = evalResultSchema.safeParse(JSON.parse(text));
  return parsed.success && parsed.data.agent === agent ? parsed.data : null;
}

export type EvalStatus = 'passed' | 'failed' | 'stale' | 'none';

export function evalStatus(agent: AgentKind, version: string): EvalStatus {
  const result = recordedEval(agent);
  if (!result) return 'none';
  if (result.version !== version) return 'stale';
  return result.passed && result.failed.length === 0 ? 'passed' : 'failed';
}
