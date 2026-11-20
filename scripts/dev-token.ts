/**
 * `npm run dev:token -- <email>`: a development sign-in token for local
 * tools (curl, the API docs), signed with DEV_JWT_SECRET. Development only;
 * staging and production refuse AUTH_MODE=dev.
 */
import { SignJWT } from 'jose';
import { env } from '../src/config/env.js';

if (env.MEDORA_ENV !== 'development' || env.AUTH_MODE !== 'dev') throw new Error('dev:token is for local development with AUTH_MODE=dev');
const secret = new TextEncoder().encode(env.DEV_JWT_SECRET);
let token: string;
if (process.argv[2] === '--patient') {
  // A patient sign-in (ADR 0035): `aud: "patient"` and a session id. Seeded patients are 1 and 2.
  const n = process.argv[3];
  if (!n) throw new Error('Usage: npm run dev:token -- --patient <n>');
  token = await new SignJWT({ sid: `sess_dev_${n}_${Date.now()}`, email: `patient-${n}@example.test` })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`dev_patient-${n}`)
    .setAudience('patient')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
} else {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: npm run dev:token -- <email>  or  npm run dev:token -- --patient <n>');
  token = await new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setSubject(`dev_${email}`).setIssuedAt().setExpirationTime('8h').sign(secret);
}
process.stdout.write(`${token}\n`);
