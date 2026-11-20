import { afterAll, describe, expect, it } from 'vitest';
import { CHECKED_VALUES } from '../../src/db/schema/values.js';
import { admin } from '../support/db.js';

/**
 * The database checks its own rules (ADRs 0006, 0007, 0008, 0028). Read from
 * the catalogue, so a migration that forgets one fails here.
 */
afterAll(() => admin.end());

const ZONES = ['platform', 'clinical', 'operational', 'marketing'];

/** Tables with no tenant_id column, and why. */
const NO_TENANT_COLUMN: Record<string, string> = {
  'platform.tenants': 'the tenant itself: its policy matches its own id',
  'platform.users': 'a person is held once across tenants: visible to themselves and to the tenants they belong to',
  'platform.rate_limit_counters': 'counts attempts before anyone is known, keyed by address',
  'platform.sign_ins': "a person's sign-ins, before any tenant is chosen: visible to themselves and to the tenants they belong to (ADM6)",
  'platform.job_leases': 'one row per scheduled job: job names and process ids, no tenant data (ADR 0029)',
};

/** Tables whose tenant_id may be null, and why. */
const NULLABLE_TENANT: Record<string, string> = {
  'platform.audit_log': 'platform-level entries, such as linking a sign-in, belong to no tenant',
};

/** The reviewed cross-tenant functions (ADR 0006). */
const SECURITY_DEFINER = [
  'platform.claim_user',
  'platform.my_memberships',
  'platform.my_access',
  'platform.accept_invitations',
  'platform.invite_person',
  'platform.tenants_with_due_events',
  'platform.tenant_ids',
];

async function rows<T>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(query, params)).rows as T[];
}

interface TableRow {
  name: string;
  rls: boolean;
  tenant_type: string | null;
  tenant_not_null: boolean | null;
  tenant_policy: boolean;
  columns: number;
}

const tables = await rows<TableRow>(
  `select n.nspname || '.' || c.relname as name, c.relrowsecurity as rls,
          format_type(a.atttypid, a.atttypmod) as tenant_type, a.attnotnull as tenant_not_null,
          exists (select 1 from pg_policy p where p.polrelid = c.oid
                   and pg_get_expr(p.polqual, p.polrelid) like '%current_tenant()%') as tenant_policy,
          (select count(*) from pg_attribute x where x.attrelid = c.oid and x.attnum > 0 and not x.attisdropped)::int as columns
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where c.relkind in ('r', 'p') and n.nspname = any($1)
    order by 1`,
  [ZONES],
);

describe('tenancy in the catalogue (ADR 0006)', () => {
  it('finds the tables', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(tables.filter((t) => !(t.name in NO_TENANT_COLUMN)))('$name has a tenant id and a tenant policy', (table) => {
    expect(table.tenant_type).toBe('uuid');
    if (!(table.name in NULLABLE_TENANT)) expect(table.tenant_not_null).toBe(true);
    expect(table.rls).toBe(true);
    expect(table.tenant_policy).toBe(true);
  });

  it('lists only tables that exist', () => {
    const names = new Set(tables.map((t) => t.name));
    for (const name of [...Object.keys(NO_TENANT_COLUMN), ...Object.keys(NULLABLE_TENANT)]) expect(names.has(name)).toBe(true);
  });

  it('keeps tables under 40 columns', () => {
    expect(tables.filter((t) => t.columns > 40).map((t) => t.name)).toEqual([]);
  });
});

describe('allowed values (ADR 0028)', () => {
  it.each(CHECKED_VALUES)('$table.$column matches values.ts', async ({ table, column, values }) => {
    const defs = await rows<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass and contype = 'c'`,
      [table],
    );
    // Postgres writes a one-value list as `CHECK ((column = 'value'::text))`, and longer ones with `= ANY (ARRAY[...])`.
    const listed = defs.map((d) => d.def);
    const def =
      listed.find((d) => new RegExp(`\\b${column}\\b`).test(d) && d.includes('ARRAY[')) ??
      listed.find((d) => new RegExp(`^CHECK \\(\\(${column} = '[^']+'::text\\)\\)$`).test(d));
    expect(def, `a CHECK on ${column}`).toBeDefined();
    const inDatabase = [...(def ?? '').matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
    expect(inDatabase.sort()).toEqual([...values].sort());
  });
});

describe('foreign keys (ADR 0028)', () => {
  it('every foreign key has an index that starts with its columns', async () => {
    const unindexed = await rows<{ name: string }>(
      `select c.conrelid::regclass::text || ' ' || c.conname as name
         from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where c.contype = 'f' and n.nspname = any($1)
          and not exists (
            select 1 from pg_index i
             where i.indrelid = c.conrelid and i.indpred is null
               and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
          )`,
      [ZONES],
    );
    expect(unindexed).toEqual([]);
  });
});

describe('data zones and the audit log (ADRs 0007, 0008)', () => {
  it('gives marketing no way into clinical', async () => {
    const [schema] = await rows<{ usage: boolean }>(`select has_schema_privilege('medora_marketing', 'clinical', 'USAGE') as usage`);
    expect(schema?.usage).toBe(false);
    const granted = await rows<{ name: string }>(
      `select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'clinical' and c.relkind in ('r', 'p', 'v', 'm')
          and (has_table_privilege('medora_marketing', c.oid, 'SELECT') or has_table_privilege('medora_marketing', c.oid, 'INSERT'))`,
    );
    expect(granted).toEqual([]);
  });

  it('lets no role change or remove audit entries', async () => {
    const [grants] = await rows<{ any: boolean }>(
      `select bool_or(has_table_privilege(r.rolname, 'platform.audit_log', p)) as any
         from pg_roles r, unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) p
        where r.rolname in ('medora_app', 'medora_marketing', 'medora_api')`,
    );
    expect(grants?.any).toBe(false);
  });
});

describe('functions (ADR 0006)', () => {
  it('has only the reviewed SECURITY DEFINER functions, each with a fixed search path', async () => {
    const found = await rows<{ name: string; config: string[] | null }>(
      `select n.nspname || '.' || p.proname as name, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname = any($1)`,
      [[...ZONES, 'medora']],
    );
    expect(found.map((f) => f.name).sort()).toEqual([...SECURITY_DEFINER].sort());
    for (const fn of found) expect(fn.config?.some((setting) => setting.startsWith('search_path='))).toBe(true);
  });

  it("doesn't let just anyone call them", async () => {
    const open = await rows<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('platform', 'medora')
          and has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(open).toEqual([]);
  });
});
