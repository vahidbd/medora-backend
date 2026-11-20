import type pg from 'pg';

/**
 * The API refuses to serve on a database role that row-level security
 * doesn't bind (ADRs 0006, 0025): a superuser, a role that can bypass it, or
 * one that owns (or can become the owner of) a Medora table. Run at boot.
 */
export async function databaseRoleProblems(client: Pick<pg.Pool, 'query'>): Promise<string[]> {
  const { rows } = await client.query<{ role: string; powerful: string[]; owned: number }>(`
    select current_user as role,
      array(
        select r.rolname::text from pg_roles r
         where pg_has_role(current_user, r.oid, 'MEMBER') and (r.rolsuper or r.rolbypassrls)
      ) as powerful,
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('platform', 'clinical', 'operational', 'marketing', 'medora')
          and pg_has_role(current_user, c.relowner, 'MEMBER'))::int as owned
  `);
  const row = rows[0];
  if (!row) return ['could not read the database role'];
  const problems: string[] = [];
  if (row.powerful.length > 0) problems.push(`${row.role} is or can become a superuser or a role that bypasses row-level security`);
  if (row.owned > 0) problems.push(`${row.role} owns, or can act as the owner of, ${row.owned} Medora table(s)`);
  return problems;
}

export async function assertSafeDatabaseRole(client: Pick<pg.Pool, 'query'>): Promise<void> {
  const problems = await databaseRoleProblems(client);
  if (problems.length > 0) {
    throw new Error(`Refusing to serve: the database role isn't bound by row-level security.\n${problems.map((p) => `  ${p}`).join('\n')}\n  Connect as medora_api (README, "Setting up a database").`);
  }
}
