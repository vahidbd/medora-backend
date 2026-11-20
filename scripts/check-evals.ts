/**
 * Eval results match their agents (docs/decisions/agents.md AGT10). An agent
 * may have no recorded result (it then can't be switched on anywhere), but a
 * recorded result for an older version fails: a change to a prompt, a tool,
 * the model or the safety screen can't merge with stale results. Every agent
 * has eval cases.
 */
import { existsSync, readFileSync } from 'node:fs';

// Building the app needs configuration but never connects to the database.
process.env.MEDORA_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://medora_api:medora_api@127.0.0.1:5432/medora';
process.env.AUTH_MODE = 'dev';
process.env.DEV_JWT_SECRET ??= 'eval-check-only-secret-xxxxxxxxxxxxxxxxxxxxx';
process.env.AGENT_EVAL_RESULTS_DIR = 'evals/results';

const { buildApp } = await import('../src/app.js');
const { AGENT_KINDS } = await import('../src/db/schema/values.js');
const { recordedEval, resultsPath } = await import('../src/modules/agents/evals.js');
const { agentVersion } = await import('../src/modules/agents/policy.js');

const app = await buildApp();
await app.ready();
const problems: string[] = [];
for (const agent of AGENT_KINDS) {
  const cases = `evals/${agent.replace(/_/g, '-')}.json`;
  if (!existsSync(cases) || (JSON.parse(readFileSync(cases, 'utf8')) as { cases: unknown[] }).cases.length === 0) problems.push(`${agent} has no eval cases (${cases})`);
  const path = resultsPath(agent);
  if (!existsSync(path)) continue;
  const result = recordedEval(agent);
  const version = agentVersion(agent, app.agentTools);
  if (!result) problems.push(`${path} doesn't parse`);
  else if (result.version !== version) {
    problems.push(`${path} is for version ${result.version}, but ${agent} is now ${version}: run npm run evals -- --agent ${agent} --record with staging credentials, and commit the result`);
  }
}
await app.close();
if (problems.length > 0) {
  process.stderr.write(`Eval results:\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Eval results: every recorded result matches its agent.\n');
