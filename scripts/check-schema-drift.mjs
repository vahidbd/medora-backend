#!/usr/bin/env node
/**
 * The Drizzle schema and the migrations agree: generating a migration from
 * src/db/schema now would produce nothing. Runs drizzle-kit against a copy of
 * the migrations in a temporary folder, so the repo is never touched.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'medora-drift-'));
try {
  cpSync('src/db/migrations', join(work, 'migrations'), { recursive: true });
  // drizzle-kit wants a relative output folder.
  const out = relative(process.cwd(), join(work, 'migrations'));
  const config = join(work, 'drizzle.config.mjs');
  writeFileSync(config, `export default ${JSON.stringify({ schema: resolve('src/db/schema/index.ts'), out, dialect: 'postgresql' })};\n`);
  let output = '';
  try {
    output = execFileSync('npx', ['drizzle-kit', 'generate', '--config', config, '--name', 'drift'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (/No schema changes/i.test(output)) {
    console.log('Schema drift: none, the migrations match src/db/schema.');
  } else if (readdirSync(join(work, 'migrations')).some((name) => name.includes('_drift'))) {
    console.error('The Drizzle schema has changes no migration makes. Run npm run db:generate and commit the migration.');
    process.exitCode = 1;
  } else {
    console.error(`Schema drift: drizzle-kit did not say whether the schema changed:\n${output}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
