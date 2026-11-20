import { buildApp } from './app.js';
import { env } from './config/env.js';
import { checkDatabaseRole, closeDatabase } from './db/health.js';
import { flushErrorTracking, reportError, startErrorTracking } from './lib/error-tracking.js';

// Before anything serves, so a failure while starting is reported too.
startErrorTracking({ dsn: env.SENTRY_DSN, environment: env.MEDORA_ENV, release: env.RELEASE_SHA, service: 'api' });

const app = await buildApp();

try {
  // Refuse to serve on a role row-level security doesn't bind (ADR 0025).
  await checkDatabaseRole();
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  reportError(error, { tags: { phase: 'start' } });
  await flushErrorTracking();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`received ${signal}, shutting down`);
    // If draining wedges, exit before the host escalates to SIGKILL.
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    await app.close();
    await closeDatabase();
    await flushErrorTracking();
    process.exit(0);
  });
}
