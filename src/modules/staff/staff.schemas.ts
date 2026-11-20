import { z } from 'zod';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, ROLES } from '../../db/schema/values.js';
import { PERMISSIONS } from '../../lib/permissions.js';

export const roleSchema = z.enum(MEMBERSHIP_ROLES);
export const startingRoleSchema = z.enum(ROLES);
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export const permissionSchema = z.enum(PERMISSIONS);

/** A custom role, as a membership names it. Starting roles are named by the web app from their key. */
const customRoleRef = z.object({ id: z.uuid(), name: z.string() }).nullable();

export const meReply = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  /** Whether this session verified a second factor; without one, every tenant route answers `two_step_required` (ADM6). */
  secondFactor: z.boolean(),
  memberships: z.array(
    z.object({
      membershipId: z.uuid(),
      tenantId: z.uuid(),
      tenantName: z.string(),
      role: roleSchema,
      customRole: customRoleRef,
      status: membershipStatusSchema,
      /** Access ends then, if set (ADM7). */
      expiresAt: z.iso.datetime().nullable(),
      /** What the role may do there now, so the web app shows only what the person can use. The API still checks every call. */
      permissions: z.array(permissionSchema),
      /** Break-glass (ADM3): whether the role holds clinical permissions it can only use under it, and until when it is open. */
      breakGlass: z.object({ available: z.boolean(), until: z.iso.datetime().nullable() }),
    }),
  ),
});

export const staffMember = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: roleSchema,
  customRole: customRoleRef,
  status: membershipStatusSchema,
  /** When the last invitation went out, and when it stops working (ADM5). */
  invitedAt: z.iso.datetime().nullable(),
  invitationExpiresAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  lastSignInAt: z.iso.datetime().nullable(),
});
export type StaffMember = z.infer<typeof staffMember>;

export const staffListReply = z.object({ staff: z.array(staffMember) });

export const membershipParams = z.object({ membershipId: z.uuid() });

/** A role to give: a starting role's key, or `custom` with the custom role's id. */
const roleChoice = {
  role: roleSchema,
  customRoleId: z.uuid().nullable().optional(),
};

export const membershipChangeBody = z
  .object({
    role: roleChoice.role.optional(),
    customRoleId: roleChoice.customRoleId,
    status: z.enum(['active', 'suspended']).optional(),
    /** Access ends at this instant; null removes the end (ADM7). */
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((body) => body.role !== undefined || body.status !== undefined || body.expiresAt !== undefined, {
    message: 'Send a role, a status, an end date, or more than one',
  });
export type MembershipChange = z.infer<typeof membershipChangeBody>;

export const invitationBody = z
  .object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(120).optional(),
    ...roleChoice,
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type InvitationInput = z.infer<typeof invitationBody>;

export const invitationReply = z.object({
  member: staffMember,
  /** Whether the invitation email went out. `not_configured` in development without a Clerk key (ADM5). */
  email: z.enum(['sent', 'failed', 'not_configured']),
});

export const withdrawnReply = z.object({ membershipId: z.uuid() });

export const signInRow = z.object({
  at: z.iso.datetime(),
  clientIp: z.string().nullable(),
  device: z.string().nullable(),
  secondFactor: z.boolean(),
});
export const signInsReply = z.object({ signIns: z.array(signInRow) });
