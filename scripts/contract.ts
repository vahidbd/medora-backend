/**
 * The API contract (ADR 0014): writes contract/openapi.json from the routes'
 * schemas. The web app generates its types from this file. `--check` fails
 * when the committed file is out of date.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Building the app needs configuration but never connects to the database.
process.env.MEDORA_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://medora_api:medora_api@127.0.0.1:5432/medora';
process.env.AUTH_MODE = 'dev';
process.env.DEV_JWT_SECRET ??= 'contract-generation-only-secret-xxxxxxxxxxxx';
process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');

const { buildApp } = await import('../src/app.js');
const app = await buildApp();
await app.ready();
const document = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();

const path = 'contract/openapi.json';
if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(path, 'utf8');
  } catch {
    // Missing counts as out of date.
  }
  if (committed !== document) {
    process.stderr.write(`${path} is out of date. Run npm run contract and commit it.\n`);
    process.exit(1);
  }
  process.stdout.write(`Contract: ${path} is up to date.\n`);
} else {
  mkdirSync('contract', { recursive: true });
  writeFileSync(path, document);
  process.stdout.write(`Wrote ${path}.\n`);
}
process.exit(0);
