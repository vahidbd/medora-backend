import { describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER, clientIpOf, signClientIp } from '../../src/lib/client-ip.js';

const secret = 's'.repeat(40);
const now = Date.UTC(2026, 10, 20, 1, 0, 0);
const socket = { remoteAddress: '10.0.0.9' };

describe('the trusted client address (ADR 0030)', () => {
  it('believes an address the web app signed', () => {
    const request = { headers: { [CLIENT_IP_HEADER]: '203.0.113.7', [CLIENT_IP_SIGNATURE_HEADER]: signClientIp('203.0.113.7', secret, now) }, socket };
    expect(clientIpOf(request, { secret, edgeHeader: null }, now)).toBe('203.0.113.7');
  });

  it('ignores a signature made with another key, or too old', () => {
    const forged = { headers: { [CLIENT_IP_HEADER]: '203.0.113.7', [CLIENT_IP_SIGNATURE_HEADER]: signClientIp('203.0.113.7', 'x'.repeat(40), now) }, socket };
    expect(clientIpOf(forged, { secret, edgeHeader: null }, now)).toBe('10.0.0.9');
    const stale = { headers: { [CLIENT_IP_HEADER]: '203.0.113.7', [CLIENT_IP_SIGNATURE_HEADER]: signClientIp('203.0.113.7', secret, now - 600_000) }, socket };
    expect(clientIpOf(stale, { secret, edgeHeader: null }, now)).toBe('10.0.0.9');
  });

  it('never believes X-Forwarded-For', () => {
    const request = { headers: { 'x-forwarded-for': '198.51.100.1' }, socket };
    expect(clientIpOf(request, { secret: null, edgeHeader: null }, now)).toBe('10.0.0.9');
  });

  it("uses the host edge's header when there is one", () => {
    const request = { headers: { 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.1' }, socket };
    expect(clientIpOf(request, { secret: null, edgeHeader: 'x-real-ip' }, now)).toBe('198.51.100.2');
  });
});
