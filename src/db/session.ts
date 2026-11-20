import { sql } from 'drizzle-orm';
import type { Role } from './schema/values.js';
import { db } from './client.js';

/**
 * Who a verified sign-in is, before any tenant is chosen: the reviewed
 * cross-tenant functions in the security migration (ADR 0006, FND2).
 */

export interface SignInMembership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  role: Role;
  status: 'active' | 'suspended';
}

export interface SignedInUser {
  userId: string;
  email: string;
  memberships: SignInMembership[];
}

/** Null when the sign-in has no Medora account: nobody invited this email, or it isn't verified. */
export async function findSignedInUser(
  identity: { clerkUserId: string; email: string | null },
  requestId: string,
): Promise<SignedInUser | null> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: string | null }>(
      sql`select platform.claim_user(${identity.clerkUserId}, ${identity.email}, ${requestId}) as id`,
    );
    const userId = claimed.rows[0]?.id;
    if (!userId) return null;
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const user = await tx.execute<{ email: string }>(sql`select email from platform.users where id = ${userId}`);
    const rows = await tx.execute<{ membership_id: string; tenant_id: string; tenant_name: string; role: Role; status: 'active' | 'suspended' }>(
      sql`select membership_id, tenant_id, tenant_name, role, status from platform.my_memberships()`,
    );
    return {
      userId,
      email: user.rows[0]?.email ?? '',
      memberships: rows.rows.map((row) => ({
        membershipId: row.membership_id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        role: row.role,
        status: row.status,
      })),
    };
  });
}
