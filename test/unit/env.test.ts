import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const LIVE_KEY = `pk_live_${Buffer.from('clerk.example.com.au$').toString('base64')}`;
const TEST_KEY = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`;
const PATIENT_LIVE_KEY = `pk_live_${Buffer.from('clerk.patients.example.com.au$').toString('base64')}`;
const PATIENT_TEST_KEY = `pk_test_${Buffer.from('patients.clerk.accounts.dev$').toString('base64')}`;

/** Everything staging needs (ADR 0025). Made-up values. Production also needs the KMS key provider, which doesn't exist yet (ENC3). */
const production: NodeJS.ProcessEnv = {
  MEDORA_ENV: 'production',
  DATABASE_URL: 'postgres://medora_api:x@db.internal:5432/medora',
  AUTH_MODE: 'clerk',
  CLERK_PUBLISHABLE_KEY: LIVE_KEY,
  CLERK_AUTHORIZED_PARTIES: 'https://console.example.com.au',
  CLERK_PATIENT_PUBLISHABLE_KEY: PATIENT_LIVE_KEY,
  CLERK_PATIENT_AUTHORIZED_PARTIES: 'https://care.example.com.au',
  STORAGE_MODE: 's3',
  S3_BUCKET: 'medora-files',
  S3_REGION: 'ap-southeast-2',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'key',
  FORWARDED_IP_SECRET: 'a'.repeat(40),
  RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
  FIELD_KEY_PROVIDER: 'local',
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};
const staging: NodeJS.ProcessEnv = { ...production, MEDORA_ENV: 'staging' };

function refusal(source: NodeJS.ProcessEnv): string {
  try {
    loadEnv(source);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('production and staging refuse unsafe settings', () => {
  it('starts staging with everything in place', () => {
    expect(loadEnv(staging).MEDORA_ENV).toBe('staging');
  });

  it('refuses production while field keys are sealed by an environment variable (ENC3)', () => {
    expect(refusal(production)).toContain('FIELD_KEY_PROVIDER must be a KMS provider in production');
  });

  it.each([
    ['no field key', { FIELD_ENCRYPTION_KEY: undefined }, 'FIELD_ENCRYPTION_KEY must be base64 of 32 random bytes'],
    ['a short field key', { FIELD_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }, 'FIELD_ENCRYPTION_KEY must be base64 of 32 random bytes'],
    ['the example field key', { FIELD_ENCRYPTION_KEY: 'bWVkb3JhLWxvY2FsLWRldmVsb3BtZW50LWtleS0zMmI=' }, 'must not be the example key'],
  ])('refuses %s in staging', (_name, change, message) => {
    expect(refusal({ ...staging, ...change })).toContain(message);
  });

  it.each([
    ['dev sign-in', { AUTH_MODE: 'dev', DEV_JWT_SECRET: 'x'.repeat(40) }, 'AUTH_MODE must be clerk'],
    ['a development secret', { DEV_JWT_SECRET: 'x'.repeat(40) }, 'DEV_JWT_SECRET must not be set'],
    ['a Clerk development key', { CLERK_PUBLISHABLE_KEY: TEST_KEY }, 'production instance key'],
    ['no allowed origins', { CLERK_AUTHORIZED_PARTIES: '' }, 'CLERK_AUTHORIZED_PARTIES is required'],
    ['no patient sign-in instance', { CLERK_PATIENT_PUBLISHABLE_KEY: undefined }, 'CLERK_PATIENT_PUBLISHABLE_KEY is required'],
    ['a patient Clerk development key', { CLERK_PATIENT_PUBLISHABLE_KEY: PATIENT_TEST_KEY }, 'CLERK_PATIENT_PUBLISHABLE_KEY must be a production instance key'],
    ['patients on the staff instance', { CLERK_PATIENT_PUBLISHABLE_KEY: LIVE_KEY }, 'must not be the staff instance'],
    ['no patient app origins', { CLERK_PATIENT_AUTHORIZED_PARTIES: '' }, 'CLERK_PATIENT_AUTHORIZED_PARTIES is required'],
    ['files on local disk', { STORAGE_MODE: 'local' }, 'STORAGE_MODE must be s3'],
    ['storage outside Australia', { S3_REGION: 'us-east-1' }, 'Australian region'],
    ['no client address secret', { FORWARDED_IP_SECRET: undefined }, 'FORWARDED_IP_SECRET'],
    ['an unknown release', { RELEASE_SHA: undefined }, 'release commit is unknown'],
  ])('refuses %s', (_name, change, message) => {
    expect(refusal({ ...production, ...change })).toContain(message);
  });

  it('lets staging use a Clerk development instance', () => {
    expect(loadEnv({ ...staging, CLERK_PUBLISHABLE_KEY: TEST_KEY }).MEDORA_ENV).toBe('staging');
  });
});

describe('outside a deployed service', () => {
  const development: NodeJS.ProcessEnv = {
    MEDORA_ENV: 'development',
    DATABASE_URL: 'postgres://medora_api:medora_api@127.0.0.1:5432/medora',
    DEV_JWT_SECRET: 'x'.repeat(40),
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
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
