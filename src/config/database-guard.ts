/**
 * Outside a deployed service, Medora connects only to a local database
 * (ADR 0025). A laptop, a test run or a cloud coding session that picks up a
 * staging or production connection string from a stale `.env` or an exported
 * variable would read and write real patient data without anyone meaning to,
 * so it stops at boot instead.
 *
 * ALLOW_REMOTE_DATABASE=1 lets a supervised one-off job reach staging on
 * purpose. Tests never accept a remote database, whatever is set.
 *
 * No imports, so drizzle.config.ts and the test setup can use it too.
 */

export const DATABASE_VARIABLES = ['DATABASE_URL', 'DATABASE_MIGRATION_URL'] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The host of a postgres:// connection string: '' for a local socket, null when it doesn't parse. */
export function databaseHost(url: string): string | null {
  try {
    return new URL(url.replace(/^postgres(ql)?:/i, 'http:')).hostname;
  } catch {
    return null;
  }
}

export function isLocalDatabase(url: string): boolean {
  const host = databaseHost(url);
  return host !== null && (host === '' || LOCAL_HOSTS.has(host.toLowerCase()));
}

/** Staging and production run as deployed services; everything else is development or a test. */
export function isDeployedService(source: NodeJS.ProcessEnv): boolean {
  return source.MEDORA_ENV === 'staging' || source.MEDORA_ENV === 'production';
}

/** The database variables that point somewhere they shouldn't. */
export function remoteDatabaseVariables(source: NodeJS.ProcessEnv): string[] {
  if (isDeployedService(source)) return [];
  const allowed = source.ALLOW_REMOTE_DATABASE === '1' && source.MEDORA_ENV !== 'test';
  if (allowed) return [];
  return DATABASE_VARIABLES.filter((name) => {
    const value = source[name];
    return value !== undefined && value !== '' && !isLocalDatabase(value);
  });
}

export function assertDatabaseTargetAllowed(source: NodeJS.ProcessEnv = process.env): void {
  const names = remoteDatabaseVariables(source);
  if (names.length === 0) return;
  throw new Error(
    [
      `Refusing to connect: ${names.join(' and ')} point${names.length === 1 ? 's' : ''} at a database that isn't local, outside a deployed service.`,
      '  Development, tests and coding sessions use a local Postgres (see .env.example).',
      '  A supervised one-off job against staging may set ALLOW_REMOTE_DATABASE=1. Tests never may.',
    ].join('\n'),
  );
}
