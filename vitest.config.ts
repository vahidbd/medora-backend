import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Tests run against a real Postgres (TEST_DATABASE_URL, a superuser on a
 * local or CI server). test/global-setup.ts migrates one database and clones
 * it once per worker; test/setup-env.ts points each worker's API connection
 * at its own copy, as medora_api, so row-level security is really in force.
 * Files a worker runs one after another share its copy: a test never assumes
 * a table starts empty.
 */
const workers = Number(process.env.TEST_WORKERS) || Math.max(1, Math.min(4, availableParallelism()));
process.env.TEST_WORKERS = String(workers);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // A test whose expectations never ran fails instead of passing (ADR 0031).
    expect: { requireAssertions: true },
    pool: 'forks',
    maxWorkers: workers,
    isolate: true,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    env: { MEDORA_ENV: 'test' },
  },
});
