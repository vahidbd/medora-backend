/**
 * Run an agent's eval cases (docs/decisions/agents.md AGT10):
 *
 *   npm run evals -- --agent support             # every case, with the configured model
 *   npm run evals -- --agent support --record    # and record the result (Bedrock only)
 *
 * The cases (evals/<agent>.json) run through the same engine as production,
 * with the agent's real prompt and tools, and tool replies taken from the
 * case. Grading is plain rules. Recording needs AGENT_MODEL_CLIENT=bedrock
 * with staging credentials: a stand-in's result proves nothing. Cases are
 * synthetic; never put a real patient's words in one.
 */
import { readFileSync, writeFileSync } from 'node:fs';

process.env.MEDORA_ENV ??= 'development';
const { buildApp } = await import('../src/app.js');
const { env } = await import('../src/config/env.js');
const { AGENT_KINDS } = await import('../src/db/schema/values.js');
const { AGENT_DEFINITIONS } = await import('../src/modules/agents/definitions.js');
const { resultsPath } = await import('../src/modules/agents/evals.js');
const { configuredModelClient } = await import('../src/modules/agents/model/index.js');
const { agentVersion, toolsOf, TOOL_POLICY } = await import('../src/modules/agents/policy.js');
const { runEngine } = await import('../src/modules/agents/runtime/engine.js');
type AgentKind = (typeof AGENT_KINDS)[number];

interface Expectation {
  outcome?: 'replied' | 'handed_off';
  outcomeIn?: ('replied' | 'handed_off')[];
  reason?: string;
  calls?: string[];
  noCalls?: boolean;
  replyIncludes?: string[];
  replyExcludes?: string[];
}
interface EvalCase {
  id: string;
  channel: 'chat' | 'email' | 'sms' | 'voice' | 'job';
  verified: boolean;
  messages: string[];
  tools?: Record<string, { status: number; body: unknown }>;
  expect?: Expectation;
  expectAny?: Expectation[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function failures(expectation: Expectation, outcome: { kind: string; reason?: string; text?: string }, calls: string[]): string[] {
  const problems: string[] = [];
  const reply = (outcome.text ?? '').toLowerCase();
  if (expectation.outcome && outcome.kind !== expectation.outcome) problems.push(`ended ${outcome.kind}, wanted ${expectation.outcome}`);
  if (expectation.outcomeIn && !expectation.outcomeIn.includes(outcome.kind as 'replied')) problems.push(`ended ${outcome.kind}`);
  if (expectation.reason && outcome.reason !== expectation.reason) problems.push(`handoff reason ${outcome.reason ?? 'none'}, wanted ${expectation.reason}`);
  if (expectation.noCalls && calls.length > 0) problems.push(`called ${calls.join(', ')}`);
  for (const name of expectation.calls ?? []) if (!calls.includes(name)) problems.push(`never called ${name}`);
  for (const text of expectation.replyIncludes ?? []) if (!reply.includes(text.toLowerCase())) problems.push(`reply lacks "${text}"`);
  for (const text of expectation.replyExcludes ?? []) if (reply.includes(text.toLowerCase())) problems.push(`reply has "${text}"`);
  return problems;
}

const record = process.argv.includes('--record');
const only = argument('agent');
if (record && env.AGENT_MODEL_CLIENT !== 'bedrock') {
  process.stderr.write('Recording needs AGENT_MODEL_CLIENT=bedrock, with staging credentials.\n');
  process.exit(1);
}
const agents = (only ? [only] : AGENT_KINDS) as AgentKind[];
const app = await buildApp();
await app.ready();
const model = configuredModelClient();
let anyFailed = false;

for (const agent of agents) {
  const definition = AGENT_DEFINITIONS[agent];
  const { cases } = JSON.parse(readFileSync(`evals/${agent.replace(/_/g, '-')}.json`, 'utf8')) as { cases: EvalCase[] };
  const failed: string[] = [];
  for (const testCase of cases) {
    const calls: string[] = [];
    const tools = toolsOf(agent, app.agentTools).filter((tool) => !TOOL_POLICY[tool.name]!.patientRecord || testCase.verified);
    const history = testCase.messages.map((text) => ({ role: testCase.channel === 'job' ? ('staff' as const) : ('patient' as const), content: [{ type: 'text', text }], untrusted: testCase.channel !== 'job' }));
    const result = await runEngine(
      { definition, displayName: definition.defaultName, channel: testCase.channel, verified: testCase.verified, tools, history, deadline: Date.now() + 120_000 },
      {
        model,
        now: Date.now,
        stillOn: async () => true,
        withinBudget: async () => true,
        runTool: async (name) => {
          calls.push(name);
          const reply = testCase.tools?.[name] ?? { status: 404, body: 'Not available in this eval' };
          return { content: JSON.stringify(reply), isError: reply.status >= 400 };
        },
        append: async () => 0,
      },
    );
    const outcome = result.outcome.kind === 'replied' ? { kind: 'replied', text: result.outcome.text } : { kind: 'handed_off', reason: result.outcome.reason };
    const options = testCase.expectAny ?? [testCase.expect ?? {}];
    const graded = options.map((expectation) => failures(expectation, outcome, calls));
    const passed = graded.some((problems) => problems.length === 0);
    if (!passed) failed.push(testCase.id);
    process.stdout.write(`${passed ? 'pass' : 'FAIL'}  ${agent}  ${testCase.id}${passed ? '' : `: ${graded[0]!.join('; ')}`}\n`);
  }
  anyFailed ||= failed.length > 0;
  if (record) {
    const result = { agent, version: agentVersion(agent, app.agentTools), model: definition.model, passed: failed.length === 0, cases: cases.length, failed, ranAt: new Date().toISOString() };
    writeFileSync(resultsPath(agent), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`recorded ${resultsPath(agent)}\n`);
  }
}
await app.close();
process.exit(anyFailed ? 1 : 0);
