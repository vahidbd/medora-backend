import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

/**
 * Migration guard (ADR 0015).
 *
 *   node scripts/check-migrations.mjs [baseRef]     (default origin/main)
 *     On every pull request, against the newest main.
 *   node scripts/check-migrations.mjs --no-base
 *     Before every deploy: the journal as it stands must be in order, so a
 *     migration that two merges put out of order stops the deploy instead of
 *     being skipped on production.
 *
 * Drizzle applies a migration only when its journal `when` is later than the
 * newest one the database has recorded, so a migration that loses a race
 * with another branch's is skipped on production without a word. And migrations
 * run before the new API takes traffic, while the old one is still serving
 * (and an automatic rollback puts the old code back on the new schema), so a
 * migration must not take away anything the previous release reads.
 *
 * Fails when the journal's entries are not in order (number, idx and `when`
 * all increasing), and, compared with the base:
 *   - a new journal entry's number, idx or `when` is not after every one on
 *     the base, or its `when` is in the future;
 *   - a migration the base already has was edited, renamed or removed (it
 *     has run on production, so the edit never would);
 *   - a journal entry has no .sql file, or a .sql file has no journal entry;
 *   - a new migration drops, renames, retypes or empties something.
 *
 * A destructive change that is meant (the second half of an expand and
 * contract, once no released code reads the old thing) passes with a
 * comment in its .sql file saying why:
 *   -- migration-guard: allow <reason>
 */
const arg = process.argv[2] ?? 'origin/main';
const base = arg === '--no-base' ? null : arg;
const dir = 'src/db/migrations';
const journalPath = `${dir}/meta/_journal.json`;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fromBase = (path) => {
  try {
    return git('show', `${base}:${path}`);
  } catch {
    return null;
  }
};

const problems = [];
const fail = (message) => problems.push(message);

const headJournal = JSON.parse(readFileSync(journalPath, 'utf8')).entries;
const baseJournalText = base === null ? '{"entries":[]}' : fromBase(journalPath);
if (baseJournalText === null) {
  console.error(`Cannot read ${journalPath} at ${base}. Fetch it first: git fetch origin main`);
  process.exit(2);
}
const baseJournal = JSON.parse(baseJournalText).entries;

const number = (tag) => Number.parseInt(tag, 10);

// The whole journal in order. Without a base this is the check: it is what
// a deploy needs, whatever was merged in between.
if (base === null) {
  for (let i = 1; i < headJournal.length; i++) {
    const [before, entry] = [headJournal[i - 1], headJournal[i]];
    if (!(number(entry.tag) > number(before.tag) && entry.idx > before.idx && entry.when > before.when)) {
      fail(
        `${entry.tag} comes after ${before.tag} in the journal, but its number, idx or when is not later. ` +
          'Drizzle would skip it on a database that already has the one before. Renumber it after the newest, with when = Date.now().',
      );
    }
  }
}
const baseByTag = new Map(baseJournal.map((entry) => [entry.tag, entry]));
const headByTag = new Map(headJournal.map((entry) => [entry.tag, entry]));

// What has already run on production must stay exactly as it is.
for (const entry of baseJournal) {
  const now = headByTag.get(entry.tag);
  if (!now) {
    fail(`${entry.tag} is on ${base} but not in the journal here: merge main into this branch (and renumber this branch's migrations after it).`);
    continue;
  }
  if (now.when !== entry.when || now.idx !== entry.idx) {
    fail(`${entry.tag} is on ${base} but its idx or when changed here. Leave applied migrations alone; add a new one.`);
  }
  const before = fromBase(`${dir}/${entry.tag}.sql`);
  const file = `${dir}/${entry.tag}.sql`;
  if (before !== null && (!existsSync(file) || readFileSync(file, 'utf8') !== before)) {
    fail(`${file} is on ${base} but was edited or removed here. It has already run on production, so an edit never will: add a new migration instead.`);
  }
}

// New migrations go after everything on the base.
const newEntries = headJournal.filter((entry) => !baseByTag.has(entry.tag));
const maxBase = (pick) => Math.max(-1, ...baseJournal.map(pick));
const baseWhen = maxBase((entry) => entry.when);
const baseIdx = maxBase((entry) => entry.idx);
const baseNumber = maxBase((entry) => number(entry.tag));
const latestBase = baseJournal.find((entry) => entry.when === baseWhen);
const dayAhead = Date.now() + 24 * 60 * 60 * 1000;

let previousWhen = baseWhen;
for (const entry of base === null ? [] : newEntries) {
  const renumber = `Renumber it to ${String(baseNumber + 1).padStart(4, '0')} or later with idx > ${baseIdx} and when = Date.now() (journal, .sql and snapshot names).`;
  if (number(entry.tag) <= baseNumber) {
    fail(`${entry.tag}: its number is not after ${base}'s newest (${latestBase?.tag}). ${renumber}`);
  }
  if (entry.idx <= baseIdx) {
    fail(`${entry.tag}: idx ${entry.idx} is not after ${base}'s newest idx ${baseIdx}. ${renumber}`);
  }
  if (entry.when <= baseWhen) {
    fail(`${entry.tag}: when ${entry.when} is not after ${base}'s newest (${latestBase?.tag}, ${baseWhen}). Drizzle would skip it on production without an error. ${renumber}`);
  } else if (entry.when <= previousWhen) {
    fail(`${entry.tag}: when ${entry.when} is not after the migration before it (${previousWhen}).`);
  }
  if (entry.when > dayAhead) {
    fail(`${entry.tag}: when ${entry.when} is in the future, which would make every later migration be skipped until then. Use Date.now().`);
  }
  previousWhen = Math.max(previousWhen, entry.when);
}

// Every journal entry has its SQL, and no SQL sits outside the journal.
const sqlFiles = readdirSync(dir).filter((name) => name.endsWith('.sql'));
for (const entry of headJournal) {
  if (!sqlFiles.includes(`${entry.tag}.sql`)) fail(`The journal lists ${entry.tag} but ${dir}/${entry.tag}.sql does not exist.`);
}
for (const name of sqlFiles) {
  if (!headByTag.has(name.replace(/\.sql$/, ''))) {
    fail(`${dir}/${name} is not in the journal, so it would never run. Add it with drizzle-kit, or delete it.`);
  }
}
const newest = headJournal.at(-1);
if (base === null && newest && newest.when > dayAhead) {
  fail(`${newest.tag}: when ${newest.when} is in the future, which would make every later migration be skipped until then.`);
}
const tags = headJournal.map((entry) => entry.tag);
for (const tag of new Set(tags.filter((tag, i) => tags.indexOf(tag) !== i))) fail(`${tag} is in the journal twice.`);

// New migrations only add: old code is still serving while they run.
const destructive = [
  [/\bdrop\s+(table|schema|type|view|materialized\s+view|sequence|function)\b/i, 'drops a table, type or view'],
  [/\balter\s+table\b[^;]*\bdrop\s+(?!constraint|default|not\s+null|index|identity|expression)(column\s+)?"?\w/i, 'drops a column'],
  [/\brename\b/i, 'renames'],
  [/\balter\s+column\s+"?\w+"?\s+(set\s+data\s+)?type\b/i, 'changes a column type'],
  [/\btruncate\b/i, 'truncates'],
  [/\bdelete\s+from\b/i, 'deletes rows'],
];
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
for (const entry of base === null ? [] : newEntries) {
  const file = `${dir}/${entry.tag}.sql`;
  if (!existsSync(file)) continue;
  const raw = readFileSync(file, 'utf8');
  if (/--\s*migration-guard:\s*allow\b/i.test(raw)) continue;
  const sql = stripComments(raw);
  const found = [...new Set(destructive.filter(([pattern]) => pattern.test(sql)).map(([, what]) => what))];
  if (found.length > 0) {
    fail(
      `${file} ${found.join(', ')}. The previous release keeps serving while this runs, and a rollback puts it back on this schema. ` +
        'Add the new thing now and remove the old one in a later release, once nothing reads it. ' +
        'If that is what this is, say so in the file: -- migration-guard: allow <reason>',
    );
  }
}

if (problems.length > 0) {
  console.error(`Migration guard: ${problems.length} problem(s) ${base === null ? 'in the journal' : `against ${base}`}\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  base === null
    ? `Migration guard: the journal is in order (${headJournal.length} migrations, newest ${newest?.tag ?? 'none'}).`
    : `Migration guard: ok against ${base} (${newEntries.length} new: ${newEntries.map((entry) => entry.tag).join(', ') || 'none'}).`,
);
