import { SignJWT } from 'jose';
import type { App } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { TENANT_HEADER } from '../../src/plugins/auth.js';

export async function testApp(): Promise<App> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** A development sign-in token, as AUTH_MODE=dev accepts it. */
export async function signIn(email: string, subject = `dev_${email}`): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(process.env.DEV_JWT_SECRET));
}

export function headers(token: string, tenantId?: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}) };
}
