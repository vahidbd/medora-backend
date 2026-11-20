#!/usr/bin/env node
/**
 * File names (ADR 0032): code files and their folders are kebab-case, with
 * dot-separated suffixes for their role.
 *
 *   staff.service.ts   staff.routes.ts   index.ts   tenancy.test.ts
 *
 * Checked: .ts, .mjs, .cjs and .js files under src/, test/ and scripts/.
 * Not checked: migrations, which drizzle-kit names.
 */
import { execFileSync } from 'node:child_process';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODE = /\.(ts|mjs|cjs|js)$/;

function problemWith(file) {
  const parts = file.split('/');
  if (!['src', 'test', 'scripts'].includes(parts[0]) || !CODE.test(file)) return null;
  if (file.startsWith('src/db/migrations/')) return null;
  const pieces = parts.at(-1).replace(CODE, '').split('.');
  if (!pieces.every((piece) => KEBAB.test(piece))) return `${file}: name the file in kebab-case`;
  const folder = parts.slice(1, -1).find((dir) => !KEBAB.test(dir));
  if (folder) return `${file}: the folder "${folder}" is not kebab-case`;
  return null;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const files = [...git('ls-files').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean);
const problems = files.map(problemWith).filter(Boolean);
if (problems.length > 0) {
  console.error(`File names must be kebab-case (ADR 0032):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`File names: ${files.length} files, all kebab-case.`);
