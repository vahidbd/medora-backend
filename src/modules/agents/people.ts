import { and, eq } from 'drizzle-orm';
import { memberships, roles } from '../../db/schema/index.js';
import type { MembershipRole } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { type Permission, usablePermissions } from '../../lib/permissions.js';

/** A staff member's usable permissions now, without break-glass: what an agent working for them may be narrowed to (AGT2). */
export async function staffPermissions(tx: TenantTx, userId: string): Promise<ReadonlySet<Permission>> {
  const [member] = await tx.db
    .select({ role: memberships.role, status: memberships.status, expiresAt: memberships.expiresAt, customRoleId: memberships.customRoleId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.userId, userId)));
  if (!member || member.status !== 'active' || (member.expiresAt && member.expiresAt <= new Date())) return new Set();
  let custom: { permissions: string[]; clinical: boolean } | undefined;
  if (member.customRoleId) {
    [custom] = await tx.db.select({ permissions: roles.permissions, clinical: roles.clinical }).from(roles).where(and(eq(roles.tenantId, tx.context.tenantId), eq(roles.id, member.customRoleId)));
  }
  return usablePermissions({ role: member.role as MembershipRole, customPermissions: custom?.permissions ?? null, customClinical: custom?.clinical ?? null }, false);
}
