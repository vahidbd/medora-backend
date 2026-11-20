import { env } from '../config/env.js';
import { migrateDatabase } from './migrate.js';

/** `npm run db:migrate`, and the first step of src/start.ts. */
if (!env.DATABASE_MIGRATION_URL) {
  throw new Error('DATABASE_MIGRATION_URL is required to migrate: the owner role runs migrations, never the API role.');
}
await migrateDatabase(env.DATABASE_MIGRATION_URL);
process.stdout.write('Migrations applied\n');
