import { defineConfig } from 'drizzle-kit';
import { assertDatabaseTargetAllowed } from './src/config/database-guard.js';

// drizzle-kit only generates migrations here (npm run db:generate); src/db/migrate.ts applies them.
assertDatabaseTargetAllowed(process.env);

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? 'postgres://medora_owner:medora_owner@127.0.0.1:5432/medora',
  },
});
