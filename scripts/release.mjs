#!/usr/bin/env node
/**
 * Prove what is live after a deploy, and put the previous release back if
 * the new one falls over (ADR 0024). Used by .github/workflows/deploy.yml.
 *
 *   node scripts/release.mjs prepare
 *     Writes the deployment live now (the rollback target) to $GITHUB_OUTPUT
 *     as `previous`. Run it before `railway up`.
 *
 *   node scripts/release.mjs verify <previousDeploymentId>
 *     Waits until /health answers with EXPECTED_SHA as its version, then
 *     watches /health and /health/ready for WATCH_SECONDS (default 60). If the
 *     release fails a check twice in a row, rolls back to the previous
 *     deployment and exits 1. If it can't tell (the version never shows, or
 *     Railway can't be asked), it exits 1 too: "can't tell" is a failure.
 *
 * Needs RAILWAY_TOKEN (a project token for one environment), RAILWAY_SERVICE
 * (the service's name), API_URL and EXPECTED_SHA. A missing one is a failure.
 */
import { appendFileSync } from 'node:fs';

const RAILWAY = 'https://backboard.railway.com/graphql/v2';
const WATCH_SECONDS = Number(process.env.WATCH_SECONDS ?? 60);
const VERSION_WAIT_MS = 5 * 60_000;
const PROBE_EVERY_MS = 5_000;

const [command, previousArg] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const annotate = (level, message) => console.log(`::${level}::${message.replace(/\n/g, '%0A')}`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    annotate('error', `${name} is not set. A deploy never skips itself: set it in the GitHub environment.`);
    process.exit(1);
  }
  return value;
}

async function gql(query, variables = {}) {
  const response = await fetch(RAILWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'project-access-token': required('RAILWAY_TOKEN') },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors) throw new Error(`Railway answered ${response.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data;
}

async function serviceScope() {
  const serviceName = required('RAILWAY_SERVICE');
  const { projectToken } = await gql('query { projectToken { projectId environmentId } }');
  const { project } = await gql('query ($id: String!) { project(id: $id) { services { edges { node { id name } } } } }', { id: projectToken.projectId });
  const service = project.services.edges.map((edge) => edge.node).find((node) => node.name === serviceName);
  if (!service) throw new Error(`no service named ${serviceName} in the project`);
  return { projectId: projectToken.projectId, environmentId: projectToken.environmentId, serviceId: service.id };
}

async function liveDeploymentId() {
  const scope = await serviceScope();
  const { deployments } = await gql(
    'query ($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }',
    { input: { ...scope, status: { in: ['SUCCESS'] } } },
  );
  return deployments.edges[0]?.node.id ?? null;
}

async function probe(path) {
  try {
    const response = await fetch(`${required('API_URL').replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.status === 200 && body.status === 'ok', version: body.version ?? null, status: response.status };
  } catch (error) {
    return { ok: false, version: null, status: error.message };
  }
}

async function waitForVersion(expected) {
  const deadline = Date.now() + VERSION_WAIT_MS;
  let seen = null;
  while (Date.now() < deadline) {
    const health = await probe('/health');
    seen = health.version;
    if (health.ok && seen === expected) return true;
    await sleep(PROBE_EVERY_MS);
  }
  annotate('error', `After ${VERSION_WAIT_MS / 60_000} minutes /health still answers version ${seen ?? 'none'}, not ${expected}. Can't tell what is live.`);
  return false;
}

async function watch() {
  let failuresInARow = 0;
  const until = Date.now() + WATCH_SECONDS * 1000;
  while (Date.now() < until) {
    const [health, ready] = await Promise.all([probe('/health'), probe('/health/ready')]);
    const problem = !health.ok ? `/health answered ${health.status}` : !ready.ok ? `/health/ready answered ${ready.status}` : null;
    failuresInARow = problem ? failuresInARow + 1 : 0;
    if (problem) console.log(`  ${problem}`);
    if (failuresInARow >= 2) return problem;
    await sleep(PROBE_EVERY_MS);
  }
  return null;
}

if (command === 'prepare') {
  const previous = await liveDeploymentId();
  console.log(`Live before this deploy: ${previous ?? 'nothing'}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `previous=${previous ?? ''}\n`);
} else if (command === 'verify') {
  const expected = required('EXPECTED_SHA');
  if (!(await waitForVersion(expected))) process.exit(1);
  console.log(`/health answers from ${expected}. Watching for ${WATCH_SECONDS}s.`);
  const problem = await watch();
  if (!problem) {
    console.log(`Release ${expected} is live and healthy.`);
    process.exit(0);
  }
  if (!previousArg) {
    annotate('error', `Release ${expected} is failing (${problem}) and there is no earlier deployment to roll back to.`);
    process.exit(1);
  }
  await gql('mutation ($id: String!) { deploymentRollback(id: $id) }', { id: previousArg });
  annotate('error', `Release ${expected} failed after going live (${problem}). Rolled back to deployment ${previousArg}.`);
  process.exit(1);
} else {
  console.error('Usage: node scripts/release.mjs prepare | verify <previousDeploymentId>');
  process.exit(2);
}
