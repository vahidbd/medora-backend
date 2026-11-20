import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * The pool, connected as medora_api (ADR 0006). Only src/db/ and src/lib/
 * may import this file: feature code reaches the database through
 * withTenant (src/db/tenant.ts), and the dependency rules refuse anything else.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  keepAlive: true,
  connectionTimeoutMillis: 10_000,
  application_name: 'medora-api',
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
