import { z } from 'zod';
import { MEMBERSHIP_STATUSES, ROLES } from '../../db/schema/values.js';
import { PERMISSIONS } from '../../lib/permissions.js';

export const roleSchema = z.enum(ROLES);
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);

export const meReply = z.object({
  userId: z.uuid(),
  email: z.string(),
  memberships: z.array(
    z.object({
      membershipId: z.uuid(),
      tenantId: z.uuid(),
      tenantName: z.string(),
      role: roleSchema,
      status: membershipStatusSchema,
      /** What the role may do there, so the web app shows only what the person can use. The API still checks every call. */
      permissions: z.array(z.enum(PERMISSIONS)),
    }),
  ),
});

export const staffMember = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  role: roleSchema,
  status: membershipStatusSchema,
});
export type StaffMember = z.infer<typeof staffMember>;

export const staffListReply = z.object({ staff: z.array(staffMember) });

export const membershipParams = z.object({ membershipId: z.uuid() });

export const membershipChangeBody = z
  .object({ role: roleSchema.optional(), status: membershipStatusSchema.optional() })
  .strict()
  .refine((body) => body.role !== undefined || body.status !== undefined, { message: 'Send a role, a status, or both' });
export type MembershipChange = z.infer<typeof membershipChangeBody>;
