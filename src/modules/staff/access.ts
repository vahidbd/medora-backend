import { and, eq } from 'drizzle-orm';
import { roles } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { needsBreakGlass, type RoleGrant } from '../../lib/permissions.js';
import type { TenantAccess } from '../../plugins/auth.js';

/** The request's role as a grant, with a custom role's permissions read inside this transaction. */
export async function grantFor(tx: TenantTx, access: Pick<TenantAccess, 'role' | 'customRoleId'>): Promise<RoleGrant> {
  if (access.role !== 'custom' || !access.customRoleId) return { role: access.role };
  const [row] = await tx.db
    .select({ permissions: roles.permissions, clinical: roles.clinical })
    .from(roles)
    .where(and(eq(roles.tenantId, tx.context.tenantId), eq(roles.id, access.customRoleId)));
  return { role: 'custom', customPermissions: row?.permissions ?? [], customClinical: row?.clinical ?? false };
}

export async function needsBreakGlassFor(tx: TenantTx, access: Pick<TenantAccess, 'role' | 'customRoleId'>): Promise<boolean> {
  return needsBreakGlass(await grantFor(tx, access));
}
