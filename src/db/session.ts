import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { MembershipRole, MembershipStatus } from './schema/values.js';
import { db } from './client.js';

/**
 * Who a verified sign-in is, before any tenant is chosen: the reviewed
 * cross-tenant functions in the security and staff access migrations
 * (ADR 0006, FND2, docs/decisions/admin.md ADM5 to ADM7).
 */

export interface SignInMembership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  role: MembershipRole;
  /** Set when `role` is `custom`. */
  customRole: { id: string; name: string; permissions: string[]; clinical: boolean } | null;
  status: MembershipStatus;
  /** Access ends then, if set (ADM7). */
  expiresAt: Date | null;
  /** Break-glass is open until then, if it is (ADM3). */
  breakGlassUntil: Date | null;
}

export interface SignedInUser {
  userId: string;
  email: string;
  displayName: string | null;
  /** Medora's own team: may create tenants and verify brand hosts (docs/decisions/admin.md ADM15). */
  platformStaff: boolean;
  memberships: SignInMembership[];
}

export interface SignInIdentity {
  clerkUserId: string;
  /** Only when the sign-in provider says it is verified. */
  email: string | null;
  /** The sign-in provider's session id, when the token carries one (ADM6). */
  sessionId: string | null;
  /** Whether this session verified a second factor (ADM6). */
  secondFactor: boolean;
}

export interface SignInContext {
  requestId: string;
  clientIp: string | null;
  device: string | null;
}

type AccessRow = {
  membership_id: string;
  tenant_id: string;
  tenant_name: string;
  role: MembershipRole;
  custom_role_id: string | null;
  custom_role_name: string | null;
  custom_permissions: string[] | null;
  custom_clinical: boolean | null;
  status: MembershipStatus;
  expires_at: Date | string | null;
  break_glass_until: Date | string | null;
};

const toDate = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

/** Null when the sign-in has no Medora account: nobody invited this email, or it isn't verified. */
export async function findSignedInUser(identity: SignInIdentity, context: SignInContext): Promise<SignedInUser | null> {
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{ id: string | null }>(
      sql`select platform.claim_user(${identity.clerkUserId}, ${identity.email}, ${context.requestId}) as id`,
    );
    const userId = claimed.rows[0]?.id;
    if (!userId) return null;
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    if (identity.sessionId) {
      const sessionHash = createHash('sha256').update(identity.sessionId).digest('hex');
      await tx.execute(
        sql`insert into platform.sign_ins (user_id, session_hash, client_ip, device, second_factor)
            values (${userId}, ${sessionHash}, ${context.clientIp}, ${context.device}, ${identity.secondFactor})
            on conflict (session_hash) do nothing`,
      );
    }
    await tx.execute(sql`select platform.accept_invitations(${context.requestId})`);
    const user = await tx.execute<{ email: string; display_name: string | null; platform_staff: boolean }>(
      sql`select email, display_name, platform_staff from platform.users where id = ${userId}`,
    );
    const rows = await tx.execute<AccessRow>(sql`select * from platform.my_access()`);
    return {
      userId,
      email: user.rows[0]?.email ?? '',
      displayName: user.rows[0]?.display_name ?? null,
      platformStaff: user.rows[0]?.platform_staff === true,
      memberships: rows.rows.map((row) => ({
        membershipId: row.membership_id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        role: row.role,
        customRole:
          row.role === 'custom' && row.custom_role_id
            ? {
                id: row.custom_role_id,
                name: row.custom_role_name ?? '',
                permissions: row.custom_permissions ?? [],
                clinical: row.custom_clinical === true,
              }
            : null,
        status: row.status,
        expiresAt: toDate(row.expires_at),
        breakGlassUntil: toDate(row.break_glass_until),
      })),
    };
  });
}
