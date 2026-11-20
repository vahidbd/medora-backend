/**
 * `npm run dev:token -- <email>`: a development sign-in token for local
 * tools (curl, the API docs), signed with DEV_JWT_SECRET. Development only;
 * staging and production refuse AUTH_MODE=dev.
 */
import { SignJWT } from 'jose';
import { env } from '../src/config/env.js';

if (env.MEDORA_ENV !== 'development' || env.AUTH_MODE !== 'dev') throw new Error('dev:token is for local development with AUTH_MODE=dev');
const email = process.argv[2];
if (!email) throw new Error('Usage: npm run dev:token -- <email>');
// A verified second factor and a session id, as a Clerk session token carries them (docs/decisions/admin.md ADM6).
const token = await new SignJWT({ email, fva: [0, 0], sid: `dev_session_${Date.now()}` })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(`dev_${email}`)
  .setIssuedAt()
  .setExpirationTime('8h')
  .sign(new TextEncoder().encode(env.DEV_JWT_SECRET));
process.stdout.write(`${token}\n`);
