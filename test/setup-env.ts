import { TEST_API_PASSWORD, urlFor, workerDatabaseName } from './database-urls.js';

/**
 * Runs before each test file: the app connects to this worker's database as
 * medora_api (row-level security in force), and fixtures connect as the
 * superuser (test/support/db.ts).
 */
const database = workerDatabaseName(process.env.VITEST_POOL_ID ?? '1');
process.env.MEDORA_ENV = 'test';
process.env.DATABASE_URL = urlFor(database, { user: 'medora_api', password: TEST_API_PASSWORD });
process.env.TEST_ADMIN_DATABASE_URL = urlFor(database);
process.env.AUTH_MODE = 'dev';
process.env.DEV_JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
// A made-up key for tests only: 32 bytes of 0x07.
process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
for (const name of ['DATABASE_MIGRATION_URL', 'RELEASE_SHA', 'SENTRY_DSN', 'FORWARDED_IP_SECRET', 'CLERK_PUBLISHABLE_KEY']) delete process.env[name];
