import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { memberships } from '../../db/schema/index.js';
import { withPerson, withTenant } from '../../db/tenant.js';
import { requireTenant, tenantContextOf, grantOf } from '../../plugins/auth.js';
import { NotFoundError, TooManyRequestsError, UnauthorizedError } from '../../lib/errors.js';
import { needsBreakGlass, usablePermissions } from '../../lib/permissions.js';
import { countAttempt, type Limit } from '../../lib/rate-limit.js';
import { invitations } from './invitations.js';
import {
  invitationBody,
  invitationReply,
  meReply,
  membershipChangeBody,
  membershipParams,
  signInsReply,
  staffListReply,
  staffMember,
  withdrawnReply,
} from './staff.schemas.js';
import { changeMembership, inviteStaff, listStaff, resendInvitation, signInsOf, withdrawInvitation } from './staff.service.js';

/** Invitations per tenant per hour (ADM5): plenty for onboarding a clinic, not for spraying email. */
export const INVITATION_LIMIT: Limit = { name: 'staff-invitation', max: 60, windowSeconds: 3600 };

const NO_AGENT = { none: 'Who may do what is decided by a person, never an agent (ADR 0012, docs/decisions/admin.md ADM4)' } as const;

export const staffRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/me',
    {
      config: { access: 'signed-in' },
      schema: { tags: ['staff'], summary: 'The signed-in person and the tenants they belong to', response: { 200: meReply } },
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new UnauthorizedError();
      const now = Date.now();
      return {
        userId: auth.userId,
        email: auth.email,
        displayName: auth.displayName,
        secondFactor: auth.secondFactor,
        platformStaff: auth.platformStaff,
        memberships: auth.memberships.map((membership) => {
          const grant = grantOf(membership);
          const until = membership.breakGlassUntil && membership.breakGlassUntil.getTime() > now ? membership.breakGlassUntil : null;
          return {
            membershipId: membership.membershipId,
            tenantId: membership.tenantId,
            tenantName: membership.tenantName,
            role: membership.role,
            customRole: membership.customRole ? { id: membership.customRole.id, name: membership.customRole.name } : null,
            status: membership.status,
            expiresAt: membership.expiresAt?.toISOString() ?? null,
            permissions: [...usablePermissions(grant, until !== null)],
            breakGlass: { available: needsBreakGlass(grant), until: until?.toISOString() ?? null },
          };
        }),
      };
    },
  );

  app.get(
    '/me/sign-ins',
    {
      config: { access: 'signed-in' },
      schema: { tags: ['staff'], summary: 'Your own recent sign-ins', response: { 200: signInsReply } },
    },
    async (request) => {
      const auth = request.auth;
      if (!auth) throw new UnauthorizedError();
      return withPerson(auth.userId, (tx) => signInsOf(tx.db, auth.userId));
    },
  );

  app.get(
    '/staff',
    {
      config: { access: { permission: 'staff:read' } },
      schema: { tags: ['staff'], summary: "The tenant's staff, their roles and invitations", response: { 200: staffListReply } },
    },
    async (request) => ({ staff: await withTenant(tenantContextOf(request), listStaff) }),
  );

  app.patch(
    '/staff/:membershipId',
    {
      config: {
        access: { permission: 'staff:manage' },
        audit: ['membership.role_changed', 'membership.status_changed', 'membership.expiry_changed'],
        events: ['membership.role_changed', 'membership.status_changed', 'membership.expiry_changed'],
        agentTool: NO_AGENT,
      },
      schema: {
        tags: ['staff'],
        summary: "Change a staff member's role, access or end date",
        params: membershipParams,
        body: membershipChangeBody,
        response: { 200: staffMember },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) => changeMembership(tx, request.params.membershipId, request.body)),
  );

  app.post(
    '/staff/invitations',
    {
      config: {
        access: { permission: 'staff:manage' },
        audit: ['membership.invited'],
        events: ['membership.invited'],
        agentTool: NO_AGENT,
      },
      schema: { tags: ['staff'], summary: 'Invite someone to work here, with a role', body: invitationBody, response: { 201: invitationReply } },
    },
    async (request, reply) => {
      const { tenant } = requireTenant(request);
      const attempt = await countAttempt(INVITATION_LIMIT, tenant.tenantId);
      if (attempt.count > INVITATION_LIMIT.max) throw new TooManyRequestsError(attempt.retryAfterSeconds);
      const member = await withTenant(tenantContextOf(request), (tx) => inviteStaff(tx, request.body));
      // ADR 0029: the email goes out after the invitation has committed.
      const email = await invitations.send(member.email);
      return reply.code(201).send({ member, email });
    },
  );

  app.post(
    '/staff/:membershipId/invitation',
    {
      config: {
        access: { permission: 'staff:manage' },
        audit: ['membership.invitation_resent'],
        events: ['membership.invitation_resent'],
        agentTool: NO_AGENT,
      },
      schema: { tags: ['staff'], summary: 'Send an invitation again', params: membershipParams, response: { 200: invitationReply } },
    },
    async (request) => {
      const { tenant } = requireTenant(request);
      const attempt = await countAttempt(INVITATION_LIMIT, tenant.tenantId);
      if (attempt.count > INVITATION_LIMIT.max) throw new TooManyRequestsError(attempt.retryAfterSeconds);
      const member = await withTenant(tenantContextOf(request), (tx) => resendInvitation(tx, request.params.membershipId));
      return { member, email: await invitations.send(member.email) };
    },
  );

  app.delete(
    '/staff/:membershipId/invitation',
    {
      config: {
        access: { permission: 'staff:manage' },
        audit: ['membership.invitation_withdrawn'],
        events: ['membership.invitation_withdrawn'],
        agentTool: NO_AGENT,
      },
      schema: { tags: ['staff'], summary: 'Withdraw an invitation nobody has accepted', params: membershipParams, response: { 200: withdrawnReply } },
    },
    async (request) => {
      await withTenant(tenantContextOf(request), (tx) => withdrawInvitation(tx, request.params.membershipId));
      return { membershipId: request.params.membershipId };
    },
  );

  app.get(
    '/staff/:membershipId/sign-ins',
    {
      config: { access: { permission: 'staff:manage' } },
      schema: { tags: ['staff'], summary: "A staff member's recent sign-ins", params: membershipParams, response: { 200: signInsReply } },
    },
    async (request) =>
      withTenant(tenantContextOf(request), async (tx) => {
        const [member] = await tx.db
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.id, request.params.membershipId)));
        if (!member) throw new NotFoundError('Staff member');
        return signInsOf(tx.db, member.userId);
      }),
  );
};
