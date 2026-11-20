import { buildApp } from './app.js';
import { env } from './config/env.js';
import { checkDatabaseRole, closeDatabase } from './db/health.js';
import { flushErrorTracking, reportError, startErrorTracking } from './lib/error-tracking.js';
import { agentsLoop, catalogueProblems, configuredModelClient } from './modules/agents/index.js';

/**
 * The agents service, `medora-agents` (ADR 0240, docs/decisions/agents.md
 * AGT8): the same image as the API, serving no requests. It builds the app
 * so agents call routes in-process, claims queued runs and runs them. Only
 * this service holds the AWS credentials for Bedrock.
 */
const TICK_MS = 1_000;

startErrorTracking({ dsn: env.SENTRY_DSN, environment: env.MEDORA_ENV, release: env.RELEASE_SHA, service: 'agents' });

const app = await buildApp();
let stopping = false;

try {
  await app.ready();
  // Refuse to run on a role row-level security doesn't bind (ADR 0025).
  await checkDatabaseRole();
  const problems = catalogueProblems(app.agentTools);
  if (problems.length > 0) throw new Error(problems.join('\n'));
} catch (error) {
  app.log.fatal({ err: error }, 'agents service failed to start');
  reportError(error, { tags: { phase: 'start' } });
  await flushErrorTracking();
  process.exit(1);
}

const loop = agentsLoop({ app, model: configuredModelClient(), log: app.log });
app.log.info({ platformOn: env.AGENTS_ENABLED === 'true', model: env.AGENT_MODEL_CLIENT }, 'agents service started');

async function tick(): Promise<void> {
  if (stopping) return;
  try {
    await loop.tick();
  } catch (error) {
    reportError(error, { tags: { phase: 'tick' } });
  }
  if (!stopping) setTimeout(() => void tick(), TICK_MS);
}
void tick();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopping = true;
    app.log.info({ signal, running: loop.running }, 'agents service shutting down');
    // Let running runs finish; a run cut off here is handed to a person by the next claim (AGT8).
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    await loop.drain();
    await app.close();
    await closeDatabase();
    await flushErrorTracking();
    process.exit(0);
  });
}
