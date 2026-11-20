/**
 * Clerk proves who someone is (ADR 0011). Everything the API needs to check a
 * Clerk session token hangs off one value, Clerk's Frontend API origin: it is
 * the token's `iss`, and `<origin>/.well-known/jwks.json` publishes the keys.
 * The publishable key the web app already carries encodes that origin, so
 * both sides are configured from one value that can't drift apart.
 */

const PUBLISHABLE_KEY_PREFIXES = ['pk_test_', 'pk_live_'] as const;

/** `pk_test_` or `pk_live_` followed by base64 of the host and a trailing `$`. */
export function issuerFromPublishableKey(key: string): string {
  const prefix = PUBLISHABLE_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
  if (!prefix) throw new Error('CLERK_PUBLISHABLE_KEY must start with pk_test_ or pk_live_');
  const decoded = Buffer.from(key.slice(prefix.length), 'base64').toString('utf8');
  if (!decoded.endsWith('$')) throw new Error('CLERK_PUBLISHABLE_KEY is malformed (no host encoded)');
  const host = decoded.slice(0, -1);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
    throw new Error('CLERK_PUBLISHABLE_KEY does not encode a valid host');
  }
  return `https://${host}`;
}

/** The issuer tokens must come from: CLERK_ISSUER, else decoded from the publishable key, else null. */
export function resolveClerkIssuer(source: { CLERK_ISSUER?: string | undefined; CLERK_PUBLISHABLE_KEY?: string | undefined }): string | null {
  if (source.CLERK_ISSUER) return source.CLERK_ISSUER.replace(/\/$/, '');
  if (source.CLERK_PUBLISHABLE_KEY) return issuerFromPublishableKey(source.CLERK_PUBLISHABLE_KEY);
  return null;
}

export function clerkJwksUrl(issuer: string): URL {
  return new URL(`${issuer}/.well-known/jwks.json`);
}

/** The comma-separated CLERK_AUTHORIZED_PARTIES list: the web app origins a token may be issued for (`azp`). */
export function parseAuthorizedParties(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
