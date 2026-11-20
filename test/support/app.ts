import { SignJWT } from 'jose';
import type { App } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { TENANT_HEADER } from '../../src/plugins/auth.js';

export async function testApp(): Promise<App> {
  const app = await buildApp();
  await app.ready();
  return app;
}

export interface SignInOptions {
  /** Whether the session verified a second factor (docs/decisions/admin.md ADM6). Yes unless a test says otherwise. */
  secondFactor?: boolean;
  /** The sign-in provider's session id, for tests of sign-in history. */
  sessionId?: string;
}

/** A development sign-in token, as AUTH_MODE=dev accepts it: Clerk's claims, signed with DEV_JWT_SECRET. */
export async function signIn(email: string, subject = `dev_${email}`, options: SignInOptions = {}): Promise<string> {
  const fva = options.secondFactor === false ? [0, -1] : [0, 0];
  return new SignJWT({ email, fva, ...(options.sessionId ? { sid: options.sessionId } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(process.env.DEV_JWT_SECRET));
}

export function headers(token: string, tenantId?: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}) };
}

/**
 * A development patient sign-in token (ADR 0100): `aud: "patient"`, a session
 * id, and the verified email or mobile the sign-in proved. Made-up people only.
 */
export async function patientSignIn(subject: string, claims: { sessionId?: string; email?: string; phone?: string } = {}): Promise<string> {
  return new SignJWT({ sid: claims.sessionId ?? `sess_${subject}`, ...(claims.email ? { email: claims.email } : {}), ...(claims.phone ? { phone_number: claims.phone } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setAudience('patient')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(process.env.DEV_JWT_SECRET));
}
