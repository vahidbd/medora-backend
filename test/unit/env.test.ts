import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const LIVE_KEY = `pk_live_${Buffer.from('clerk.example.com.au$').toString('base64')}`;
const TEST_KEY = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`;

/** Everything production needs (ADR 0025). Made-up values. */
const production: NodeJS.ProcessEnv = {
  MEDORA_ENV: 'production',
  DATABASE_URL: 'postgres://medora_api:x@db.internal:5432/medora',
  AUTH_MODE: 'clerk',
  CLERK_PUBLISHABLE_KEY: LIVE_KEY,
  CLERK_AUTHORIZED_PARTIES: 'https://console.example.com.au',
  STORAGE_MODE: 's3',
  S3_BUCKET: 'medora-files',
  S3_REGION: 'ap-southeast-2',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'key',
  FORWARDED_IP_SECRET: 'a'.repeat(40),
  RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
  PUBLIC_API_URL: 'https://api.example.com.au',
  TELEPHONY: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_API_KEY_SID: 'SKtest',
  TWILIO_API_KEY_SECRET: 'secret',
  TWILIO_AUTH_TOKEN: 'token',
  PARCHMENT_MODE: 'live',
  PARCHMENT_API_URL: 'https://api.parchment.example',
  PARCHMENT_PORTAL_URL: 'https://portal.parchment.example/dashboard/patients',
  PARCHMENT_PARTNER_ID: 'partner',
  PARCHMENT_PARTNER_SECRET: 'partner-secret',
};

/** One tenant's Parchment organisation, made up. */
const organization = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: 'org_1',
  organizationSecret: 'org-secret-0123456789',
  userId: 'user_1',
  webhookSecret: 'webhook-secret-0123456789',
};

function refusal(source: NodeJS.ProcessEnv): string {
  try {
    loadEnv(source);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('production and staging refuse unsafe settings', () => {
  it('starts with everything in place', () => {
    expect(loadEnv(production).MEDORA_ENV).toBe('production');
  });

  it.each([
    ['dev sign-in', { AUTH_MODE: 'dev', DEV_JWT_SECRET: 'x'.repeat(40) }, 'AUTH_MODE must be clerk'],
    ['a development secret', { DEV_JWT_SECRET: 'x'.repeat(40) }, 'DEV_JWT_SECRET must not be set'],
    ['a Clerk development key', { CLERK_PUBLISHABLE_KEY: TEST_KEY }, 'production instance key'],
    ['no allowed origins', { CLERK_AUTHORIZED_PARTIES: '' }, 'CLERK_AUTHORIZED_PARTIES is required'],
    ['files on local disk', { STORAGE_MODE: 'local' }, 'STORAGE_MODE must be s3'],
    ['storage outside Australia', { S3_REGION: 'us-east-1' }, 'Australian region'],
    ['no client address secret', { FORWARDED_IP_SECRET: undefined }, 'FORWARDED_IP_SECRET'],
    ['an unknown release', { RELEASE_SHA: undefined }, 'release commit is unknown'],
    ['fake telephony', { TELEPHONY: 'fake' }, 'TELEPHONY must be twilio'],
    ["Twilio outside Australia", { TWILIO_REGION: 'us1' }, 'TWILIO_REGION must be au1'],
    ['callbacks over plain http', { PUBLIC_API_URL: 'http://api.example.com.au' }, 'PUBLIC_API_URL must be https'],
    ['Twilio without its signing token', { TWILIO_AUTH_TOKEN: undefined }, 'TWILIO_AUTH_TOKEN is required'],
    ['fake Parchment', { PARCHMENT_MODE: 'fake' }, 'PARCHMENT_MODE must be live'],
    ["Parchment's sandbox", { PARCHMENT_API_URL: 'https://api.sandbox.parchment.example' }, "Parchment's production addresses"],
    ['live Parchment without the partner secret', { PARCHMENT_PARTNER_SECRET: undefined }, 'PARCHMENT_PARTNER_SECRET is required'],
  ])('refuses %s', (_name, change, message) => {
    expect(refusal({ ...production, ...change })).toContain(message);
  });

  it("lets staging use Parchment's sandbox", () => {
    expect(loadEnv({ ...production, MEDORA_ENV: 'staging', PARCHMENT_API_URL: 'https://api.sandbox.parchment.example' }).MEDORA_ENV).toBe('staging');
  });

  it('lets staging use a Clerk development instance', () => {
    expect(loadEnv({ ...production, MEDORA_ENV: 'staging', CLERK_PUBLISHABLE_KEY: TEST_KEY }).MEDORA_ENV).toBe('staging');
  });
});

describe('outside a deployed service', () => {
  const development: NodeJS.ProcessEnv = {
    MEDORA_ENV: 'development',
    DATABASE_URL: 'postgres://medora_api:medora_api@127.0.0.1:5432/medora',
    DEV_JWT_SECRET: 'x'.repeat(40),
  };

  it('connects to a local database', () => {
    expect(loadEnv(development).AUTH_MODE).toBe('dev');
  });

  it('refuses a database that is not local', () => {
    expect(refusal({ ...development, DATABASE_URL: 'postgres://u:p@db.example.com:5432/medora' })).toContain('Refusing to connect');
    expect(refusal({ ...development, DATABASE_MIGRATION_URL: 'postgres://u:p@db.example.com/medora' })).toContain('DATABASE_MIGRATION_URL');
  });

  it('allows a remote database on purpose in development, never in tests', () => {
    const remote = { ...development, DATABASE_URL: 'postgres://u:p@staging.example.com/medora', ALLOW_REMOTE_DATABASE: '1' };
    expect(loadEnv(remote).MEDORA_ENV).toBe('development');
    expect(refusal({ ...remote, MEDORA_ENV: 'test' })).toContain('Refusing to connect');
  });

  it('needs a long development secret for dev sign-in', () => {
    expect(refusal({ ...development, DEV_JWT_SECRET: 'short' })).toContain('DEV_JWT_SECRET of at least 32 characters');
  });
});

describe('PARCHMENT_ORGANIZATIONS', () => {
  const development: NodeJS.ProcessEnv = {
    MEDORA_ENV: 'development',
    DATABASE_URL: 'postgres://medora_api:medora_api@127.0.0.1:5432/medora',
    DEV_JWT_SECRET: 'x'.repeat(40),
  };

  it('takes a list of organisations, one per tenant', () => {
    expect(loadEnv({ ...development, PARCHMENT_ORGANIZATIONS: JSON.stringify([organization]) }).PARCHMENT_ORGANIZATIONS).toContain('org_1');
  });

  it('refuses a tenant listed twice, and an entry missing its webhook secret', () => {
    expect(refusal({ ...development, PARCHMENT_ORGANIZATIONS: JSON.stringify([organization, organization]) })).toContain('lists a tenant twice');
    expect(refusal({ ...development, PARCHMENT_ORGANIZATIONS: JSON.stringify([{ ...organization, webhookSecret: undefined }]) })).toContain('webhookSecret');
  });

  it('never repeats a secret in its refusal', () => {
    const message = refusal({ ...development, PARCHMENT_ORGANIZATIONS: JSON.stringify([{ ...organization, organizationSecret: 'too-short' }]) });
    expect(message).toContain('organizationSecret');
    expect(message).not.toContain('too-short');
    expect(refusal({ ...development, PARCHMENT_ORGANIZATIONS: '{not json' })).toContain('not valid JSON');
  });
});
