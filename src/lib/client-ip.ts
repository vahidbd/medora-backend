import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The address a request came from, as far as it can be trusted (ADR 0030):
 * what rate limits key on. Routes read it as request.clientIp
 * (src/plugins/client-ip.ts), never request.ip.
 *
 * 1. The web app calls the API for its visitors and sends the visitor's
 *    address in `x-medora-client-ip`, with `x-medora-client-ip-signature:
 *    <unix seconds>.<HMAC-SHA256 of "<seconds>.<address>">` keyed by
 *    FORWARDED_IP_SECRET. A good signature under five minutes old: that address.
 * 2. The address the host's edge saw (it overwrites the header a caller sends).
 * 3. The socket's address.
 *
 * Never the first X-Forwarded-For entry, which any caller can write.
 */
export const CLIENT_IP_HEADER = 'x-medora-client-ip';
export const CLIENT_IP_SIGNATURE_HEADER = 'x-medora-client-ip-signature';
const MAX_AGE_SECONDS = 300;

export interface ClientIpOptions {
  /** FORWARDED_IP_SECRET, when set. */
  secret: string | null;
  /** The header the host's edge writes, when there is an edge. */
  edgeHeader: string | null;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | null;
}

function header(request: RequestLike, name: string): string | null {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}

/** An address as compared and stored: IPv4-mapped IPv6 written as IPv4; null when it isn't an address. */
function normalise(address: string | null | undefined): string | null {
  if (!address) return null;
  const plain = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  return isIP(plain) ? plain : null;
}

function mac(key: string, seconds: string, address: string): Buffer {
  return createHmac('sha256', key).update(`${seconds}.${address}`).digest();
}

/** The value for CLIENT_IP_SIGNATURE_HEADER: what the web app sends. */
export function signClientIp(address: string, key: string, now = Date.now()): string {
  const seconds = String(Math.floor(now / 1000));
  return `${seconds}.${mac(key, seconds, address).toString('base64url')}`;
}

function signedAddress(request: RequestLike, key: string, now: number): string | null {
  const address = header(request, CLIENT_IP_HEADER);
  const signature = header(request, CLIENT_IP_SIGNATURE_HEADER);
  if (!address || !signature || !normalise(address)) return null;
  const [seconds, given, extra] = signature.split('.');
  if (!seconds || !given || extra !== undefined || !/^\d{1,12}$/.test(seconds)) return null;
  if (Math.abs(now / 1000 - Number(seconds)) > MAX_AGE_SECONDS) return null;
  const expected = mac(key, seconds, address);
  const actual = Buffer.from(given, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? normalise(address) : null;
}

export function clientIpOf(request: RequestLike, options: ClientIpOptions, now = Date.now()): string {
  if (options.secret) {
    const signed = signedAddress(request, options.secret, now);
    if (signed) return signed;
  }
  const fromEdge = options.edgeHeader ? normalise(header(request, options.edgeHeader)) : null;
  return fromEdge ?? normalise(request.socket?.remoteAddress) ?? 'unknown';
}
