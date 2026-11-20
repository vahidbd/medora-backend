import { and, eq, sql } from 'drizzle-orm';
import { memberships, roles } from '../../db/schema/index.js';
import { ROLES, type Role } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { assertCanGrant, CLINICAL_ROLES, PERMISSION_ZONES, PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '../../lib/permissions.js';
import type { TenantAccess } from '../../plugins/auth.js';
import type { CustomRole, RoleInput, RolesReply, RoleUpdate } from './roles.schemas.js';

/**
 * Roles (docs/decisions/admin.md ADM1, ADM4). Starting roles come from code
 * and can't be edited; a tenant copies one into a custom role and edits
 * that. Editing a role is granting: you may only put in permissions you
 * hold, you can't edit the role you hold yourself, and no agent edits a role.
 */
type Actor = { userId: string; held: ReadonlySet<Permission>; customRoleId: string | null };

function actorOf(tx: TenantTx, access: TenantAccess): Actor {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person can change roles', 'person_only');
  return { userId: tx.context.actor.userId, held: access.held, customRoleId: access.customRoleId };
}

const known = new Set<string>(PERMISSIONS);

function cleanPermissions(keys: readonly string[]): Permission[] {
  return [...new Set(keys)].filter((key): key is Permission => known.has(key)).sort();
}

async function memberCounts(tx: TenantTx): Promise<{ starting: Map<string, number>; custom: Map<string, number> }> {
  const rows = await tx.db
    .select({ role: memberships.role, customRoleId: memberships.customRoleId, count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tx.context.tenantId), sql`${memberships.status} <> 'invited'`))
    .groupBy(memberships.role, memberships.customRoleId);
  const starting = new Map<string, number>();
  const custom = new Map<string, number>();
  for (const row of rows) {
    if (row.customRoleId) custom.set(row.customRoleId, row.count);
    else starting.set(row.role, row.count);
  }
  return { starting, custom };
}

type RoleRow = typeof roles.$inferSelect;

const toCustomRole = (row: RoleRow, members: number): CustomRole => ({
  id: row.id,
  name: row.name,
  description: row.description,
  basedOn: row.basedOn as Role,
  clinical: row.clinical,
  permissions: cleanPermissions(row.permissions),
  memberCount: members,
  updatedAt: row.updatedAt.toISOString(),
});

export async function listRoles(tx: TenantTx): Promise<RolesReply> {
  const counts = await memberCounts(tx);
  const rows = await tx.db.select().from(roles).where(eq(roles.tenantId, tx.context.tenantId)).orderBy(roles.name);
  return {
    startingRoles: ROLES.map((key) => ({
      key,
      clinical: CLINICAL_ROLES.has(key),
      permissions: [...ROLE_PERMISSIONS[key]].sort(),
      memberCount: counts.starting.get(key) ?? 0,
    })),
    customRoles: rows.map((row) => toCustomRole(row, counts.custom.get(row.id) ?? 0)),
    permissions: PERMISSIONS.map((key) => ({ key, zone: PERMISSION_ZONES[key] })),
  };
}

async function findRole(tx: TenantTx, id: string, lock = false): Promise<RoleRow> {
  const query = tx.db.select().from(roles).where(and(eq(roles.tenantId, tx.context.tenantId), eq(roles.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Role');
  return row;
}

function nameTaken(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  return code === '23505';
}

export async function createRole(tx: TenantTx, access: TenantAccess, input: RoleInput): Promise<CustomRole> {
  const actor = actorOf(tx, access);
  const permissions = cleanPermissions(input.permissions);
  assertCanGrant(actor.held, { permissions });
  let row: RoleRow | undefined;
  try {
    [row] = await tx.db
      .insert(roles)
      .values({
        tenantId: tx.context.tenantId,
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        permissions,
        basedOn: input.basedOn,
        clinical: CLINICAL_ROLES.has(input.basedOn),
      })
      .returning();
  } catch (error) {
    if (nameTaken(error)) throw new BusinessRuleError('Another role already has that name', 'role_name_taken');
    throw error;
  }
  const record = { recordTable: 'platform.roles', recordId: row!.id } as const;
  const facts = { basedOn: input.basedOn, permissions: permissions.join(',') };
  await audit(tx, { action: 'role.created', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'role.created', ...record, payload: { basedOn: input.basedOn, permissions } });
  return toCustomRole(row!, 0);
}

export async function updateRole(tx: TenantTx, access: TenantAccess, id: string, change: RoleUpdate): Promise<CustomRole> {
  const actor = actorOf(tx, access);
  const before = await findRole(tx, id, true);
  if (actor.customRoleId === id) throw new ForbiddenError("You can't edit the role you hold. Ask another admin.", 'own_role');
  const beforeKeys = cleanPermissions(before.permissions);
  const afterKeys = change.permissions === undefined ? beforeKeys : cleanPermissions(change.permissions);
  // Taking a permission away is removing it from everyone with the role, so both sides count (ADR 0030).
  assertCanGrant(actor.held, { permissions: beforeKeys });
  assertCanGrant(actor.held, { permissions: afterKeys });
  let row: RoleRow | undefined;
  try {
    [row] = await tx.db
      .update(roles)
      .set({
        ...(change.name === undefined ? {} : { name: change.name.trim() }),
        ...(change.description === undefined ? {} : { description: change.description.trim() }),
        permissions: afterKeys,
        updatedAt: new Date(),
      })
      .where(and(eq(roles.tenantId, tx.context.tenantId), eq(roles.id, id)))
      .returning();
  } catch (error) {
    if (nameTaken(error)) throw new BusinessRuleError('Another role already has that name', 'role_name_taken');
    throw error;
  }
  const added = afterKeys.filter((key) => !beforeKeys.includes(key));
  const removed = beforeKeys.filter((key) => !afterKeys.includes(key));
  const record = { recordTable: 'platform.roles', recordId: id } as const;
  const facts = { before: beforeKeys.join(','), after: afterKeys.join(','), renamed: change.name !== undefined && change.name.trim() !== before.name };
  await audit(tx, { action: 'role.changed', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'role.changed', ...record, payload: { added, removed } });
  const counts = await memberCounts(tx);
  return toCustomRole(row!, counts.custom.get(id) ?? 0);
}

/** Only a role nobody holds, and nobody has been invited into, can be deleted. */
export async function deleteRole(tx: TenantTx, access: TenantAccess, id: string): Promise<void> {
  const actor = actorOf(tx, access);
  const row = await findRole(tx, id, true);
  assertCanGrant(actor.held, { permissions: cleanPermissions(row.permissions) });
  const [used] = await tx.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.customRoleId, id)))
    .limit(1);
  if (used) throw new BusinessRuleError('Someone still has this role. Give them another role first.', 'role_in_use');
  await tx.db.delete(roles).where(and(eq(roles.tenantId, tx.context.tenantId), eq(roles.id, id)));
  const record = { recordTable: 'platform.roles', recordId: id } as const;
  await audit(tx, { action: 'role.deleted', zone: 'platform', ...record, details: { permissions: cleanPermissions(row.permissions).join(',') } });
  await emitEvent(tx, { type: 'role.deleted', ...record });
}
