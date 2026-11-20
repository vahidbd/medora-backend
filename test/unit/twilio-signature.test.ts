import { describe, expect, it } from 'vitest';
import { twilioSignature } from '../../src/modules/telephony/index.js';
import { signatureMatches } from '../../src/lib/webhooks.js';

describe("Twilio's webhook signature", () => {
  // The worked example in Twilio's security documentation.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = new URLSearchParams({
    CallSid: 'CA1234567890ABCDE',
    Caller: '+12349013030',
    Digits: '1234',
    From: '+12349013030',
    To: '+18005551212',
  });

  it('signs the address and the sorted fields', () => {
    expect(twilioSignature('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });

  it('does not depend on the order the fields arrive in', () => {
    const shuffled = new URLSearchParams([...params.entries()].reverse());
    expect(twilioSignature('12345', url, shuffled)).toBe(twilioSignature('12345', url, params));
  });
});

describe('signatureMatches', () => {
  const base = { algorithm: 'sha256' as const, secret: 'shh', payload: '{"a":1}', encoding: 'hex' as const };
  const other = '5a5a30a4ff6d5a4e0f06b3db4eaa1d0b5a8a1c6c1d1f6a9b4f3f0e1c2b3a4d5e';

  it('accepts the right signature and nothing else', async () => {
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'shh').update('{"a":1}').digest('hex');
    expect(signatureMatches({ ...base, signature })).toBe(true);
    expect(signatureMatches({ ...base, signature: other })).toBe(false);
    expect(signatureMatches({ ...base, signature: signature.slice(2) })).toBe(false);
    expect(signatureMatches({ ...base, payload: '{"a":2}', signature })).toBe(false);
  });

  it('refuses everything when the secret is missing', () => {
    expect(signatureMatches({ ...base, secret: '', signature: 'x' })).toBe(false);
  });
});
