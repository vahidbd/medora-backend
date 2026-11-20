import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { testApp } from '../support/app.js';

/** What every reply carries, and what the app refuses to register (ADRs 0014, 0024, 0030). */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe('health', () => {
  it('says which commit is live, and "development" when local (FND4)', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health' });
    expect(reply.json()).toEqual({ status: 'ok', service: 'medora-api', version: 'development' });
  });

  it('is ready when the database answers', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().database).toBe('ok');
  });
});

describe('every reply', () => {
  it('carries the security headers and is never cached', async () => {
    const reply = await app.inject({ method: 'GET', url: '/health' });
    expect(reply.headers['content-security-policy']).toContain("default-src 'none'");
    expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(reply.headers['strict-transport-security']).toContain('max-age=');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('sends no CORS headers, even when asked (FND5)', async () => {
    const reply = await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'https://elsewhere.example', 'access-control-request-method': 'GET' } });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an unknown address with the error envelope', async () => {
    const reply = await app.inject({ method: 'GET', url: '/nothing-here' });
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual({ error: { code: 'not_found', message: 'There is nothing at this address' } });
  });

  it('serves the contract outside staging and production', async () => {
    const reply = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(reply.json().paths).toHaveProperty('/v1/staff/{membershipId}');
  });
});

describe('route rules', () => {
  it('refuses to register a route that declares nothing', async () => {
    const fresh = await testApp();
    await fresh.close();
    const bare = (await import('fastify')).default();
    await bare.register((await import('../../src/plugins/route-rules.js')).routeRulesPlugin);
    expect(() => bare.post('/v1/anything', async () => ({}))).toThrow(/declares no access/);
    await bare.close();
  });
});
