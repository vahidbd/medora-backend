import dotenv from 'dotenv';
import { z } from 'zod';
import { parseAuthorizedParties, resolveClerkIssuer } from '../lib/clerk.js';
import { assertDatabaseTargetAllowed, isDeployedService } from './database-guard.js';
import { builtReleaseSha } from './release.js';

/**
 * All runtime configuration, from environment variables, checked once at
 * boot. Anything missing or malformed stops the process with a readable
 * message, and staging and production refuse unsafe settings (ADR 0025).
 */
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

const envSchema = z.object({
  /** Which Medora environment this is. Only staging and production are deployed services. */
  MEDORA_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** The API's login, `medora_api`: a member of `medora_app` that owns nothing (ADR 0006). */
  DATABASE_URL: z.string().min(1),
  /** The owner's login, for migrations only (src/db/migrate.ts). */
  DATABASE_MIGRATION_URL: optionalText,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** clerk: Clerk session tokens. dev: tokens signed with DEV_JWT_SECRET, for tests and local tools only. */
  AUTH_MODE: z.enum(['clerk', 'dev']).default('dev'),
  DEV_JWT_SECRET: optionalText,
  CLERK_PUBLISHABLE_KEY: optionalText,
  /** Clerk's Frontend API origin; decoded from CLERK_PUBLISHABLE_KEY when unset. */
  CLERK_ISSUER: optionalText,
  /** The web app origins a token may be issued for, comma-separated. */
  CLERK_AUTHORIZED_PARTIES: optionalText,

  /** Files (none yet): S3-compatible storage in an Australian region once deployed (ADRs 0005, 0025). */
  STORAGE_MODE: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: optionalText,
  S3_REGION: optionalText,
  S3_ENDPOINT: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,

  /** Shared with the web app, which signs the visitor's address with it (src/lib/client-ip.ts). */
  FORWARDED_IP_SECRET: optionalText,
  /** The header the host's edge writes the connecting address to. Default x-real-ip once deployed. */
  CLIENT_IP_HEADER: optionalText,

  /**
   * The API's public origin, e.g. https://api.example.com.au. Outside services
   * call back here, and a Twilio signature covers the exact address it called.
   */
  PUBLIC_API_URL: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),

  /** Phone and SMS (docs/decisions/telephony.md). fake: nothing leaves the process; dev and tests only. */
  TELEPHONY: z.enum(['fake', 'twilio']).default('fake'),
  TWILIO_ACCOUNT_SID: optionalText,
  /** An API key made in the Australian region; Twilio's region keys work only in their region. */
  TWILIO_API_KEY_SID: optionalText,
  TWILIO_API_KEY_SECRET: optionalText,
  /** Signs Twilio's webhooks. The Australian region's auth token, not the US one. */
  TWILIO_AUTH_TOKEN: optionalText,
  TWILIO_REGION: z.string().default('au1'),
  TWILIO_EDGE: z.string().default('sydney'),

  /** A Sentry-compatible server in Australia (ADR 0026). Unset: error tracking is off. */
  SENTRY_DSN: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),

  /** The commit being served. Baked in by the build; RELEASE_SHA or Railway's commit variable override it. */
  RELEASE_SHA: optionalText,
});

export type Env = z.infer<typeof envSchema>;

/** Australian AWS regions: Sydney and Melbourne. */
const AUSTRALIAN_REGIONS = new Set(['ap-southeast-2', 'ap-southeast-4']);

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  assertDatabaseTargetAllowed(source);
  const parsed = envSchema.safeParse({
    ...source,
    RELEASE_SHA: source.RELEASE_SHA || source.RAILWAY_GIT_COMMIT_SHA || builtReleaseSha,
  });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const config = parsed.data;
  const problems = [...authProblems(config), ...telephonyProblems(config), ...(isDeployedService(source) ? deployedProblems(config) : [])];
  if (problems.length > 0) {
    throw new Error(`Refusing to start (MEDORA_ENV=${config.MEDORA_ENV}):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return config;
}

function authProblems(config: Env): string[] {
  if (config.AUTH_MODE === 'dev') {
    return (config.DEV_JWT_SECRET ?? '').length >= 32 ? [] : ['DEV_JWT_SECRET of at least 32 characters is required when AUTH_MODE=dev'];
  }
  const problems: string[] = [];
  try {
    if (!resolveClerkIssuer(config)) problems.push('CLERK_PUBLISHABLE_KEY or CLERK_ISSUER is required when AUTH_MODE=clerk');
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

function telephonyProblems(config: Env): string[] {
  if (config.TELEPHONY !== 'twilio') return [];
  const problems: string[] = [];
  for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_AUTH_TOKEN', 'PUBLIC_API_URL'] as const) {
    if (!config[name]) problems.push(`${name} is required when TELEPHONY=twilio`);
  }
  return problems;
}

/**
 * assertDeployedSafe: what staging and production must have before they serve
 * anyone (ADR 0025). There is no switch that lets them start without it.
 */
export function deployedProblems(config: Env): string[] {
  const problems: string[] = [];
  if (config.AUTH_MODE !== 'clerk') problems.push('AUTH_MODE must be clerk (dev tokens are signed with a secret anyone with the repo can make)');
  if (config.DEV_JWT_SECRET) problems.push('DEV_JWT_SECRET must not be set');
  if (!config.CLERK_PUBLISHABLE_KEY) problems.push('CLERK_PUBLISHABLE_KEY is required');
  if (config.MEDORA_ENV === 'production' && config.CLERK_PUBLISHABLE_KEY && !config.CLERK_PUBLISHABLE_KEY.startsWith('pk_live_')) {
    problems.push('CLERK_PUBLISHABLE_KEY must be a production instance key (pk_live_) in production');
  }
  if (parseAuthorizedParties(config.CLERK_AUTHORIZED_PARTIES).length === 0) {
    problems.push('CLERK_AUTHORIZED_PARTIES is required (the web app origins, e.g. https://console.example.com.au)');
  }
  if (config.STORAGE_MODE !== 's3') problems.push('STORAGE_MODE must be s3 (a container disk is wiped on every deploy)');
  if (!config.S3_REGION || !AUSTRALIAN_REGIONS.has(config.S3_REGION)) problems.push('S3_REGION must be an Australian region (ap-southeast-2 or ap-southeast-4)');
  for (const name of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
    if (!config[name]) problems.push(`${name} is required`);
  }
  if ((config.FORWARDED_IP_SECRET ?? '').length < 32) problems.push('FORWARDED_IP_SECRET of at least 32 characters is required');
  // docs/decisions/telephony.md TEL1: a fake can't reach patients, and later it could make up consult evidence.
  if (config.TELEPHONY !== 'twilio') problems.push('TELEPHONY must be twilio');
  if (config.TWILIO_REGION !== 'au1') problems.push("TWILIO_REGION must be au1, Twilio's Australian region (ADR 0005)");
  if (config.PUBLIC_API_URL && !config.PUBLIC_API_URL.startsWith('https://')) problems.push('PUBLIC_API_URL must be https');
  if (!/^[0-9a-f]{40}$/.test(config.RELEASE_SHA ?? '')) problems.push('the release commit is unknown (build with scripts/build.mjs, or set RELEASE_SHA)');
  return problems;
}

if (process.env.MEDORA_ENV !== 'test') dotenv.config({ quiet: true });

export const env: Env = loadEnv(process.env);

export const isDeployed = env.MEDORA_ENV === 'staging' || env.MEDORA_ENV === 'production';
export const isTest = env.MEDORA_ENV === 'test';
