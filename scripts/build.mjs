#!/usr/bin/env node
/**
 * The production build: every module in src/ transpiled one for one into
 * dist/ (esbuild strips types; the type check runs in CI), the SQL
 * migrations copied beside them, and the release commit baked in so
 * /health can say which commit is live (ADR 0024).
 *
 * The commit comes from RELEASE_SHA, else release-sha.txt (written by the
 * deploy workflow before upload), else git.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const src = `${root}src`;

function releaseSha() {
  if (process.env.RELEASE_SHA) return process.env.RELEASE_SHA.trim();
  if (existsSync(`${root}release-sha.txt`)) return readFileSync(`${root}release-sha.txt`, 'utf8').trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const sha = releaseSha();
const entryPoints = readdirSync(src, { recursive: true })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .map((file) => `${src}/${file}`);

rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  entryPoints,
  outdir: `${root}dist`,
  outbase: src,
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  define: { __MEDORA_RELEASE_SHA__: JSON.stringify(sha) },
});
cpSync(`${src}/db/migrations`, `${root}dist/db/migrations`, { recursive: true });
console.log(`Built dist/ for ${sha || 'an unknown commit'}.`);
