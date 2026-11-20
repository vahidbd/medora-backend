import { createHmac } from 'node:crypto';
import { signatureMatches } from '../../lib/webhooks.js';

/**
 * Twilio signs a webhook with HMAC-SHA1 of the exact address it called,
 * followed by every form field's name and value, sorted by name, using the
 * account's auth token, base64 encoded, in `X-Twilio-Signature`.
 */
export function twilioSigningPayload(url: string, params: URLSearchParams): string {
  const names = [...new Set(params.keys())].sort();
  return url + names.map((name) => params.getAll(name).sort().map((value) => name + value).join('')).join('');
}

export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  return createHmac('sha1', authToken).update(twilioSigningPayload(url, params), 'utf8').digest('base64');
}

export function twilioSignatureMatches(authToken: string | undefined, url: string, params: URLSearchParams, signature: string | undefined): boolean {
  return signatureMatches({
    algorithm: 'sha1',
    secret: authToken ?? '',
    payload: twilioSigningPayload(url, params),
    signature: signature ?? '',
    encoding: 'base64',
  });
}
