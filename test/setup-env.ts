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
// Outside calls go to fakes; webhooks are signed with a test-only token (test/support/twilio.ts).
process.env.TELEPHONY = 'fake';
process.env.PUBLIC_API_URL = 'https://api.medora.test';
process.env.TWILIO_AUTH_TOKEN = 'test-only-twilio-auth-token';
for (const name of ['DATABASE_MIGRATION_URL', 'RELEASE_SHA', 'SENTRY_DSN', 'FORWARDED_IP_SECRET', 'CLERK_PUBLISHABLE_KEY']) delete process.env[name];
