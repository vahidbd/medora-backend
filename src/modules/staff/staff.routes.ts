import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { meReply, membershipChangeBody, membershipParams, staffListReply, staffMember } from './staff.schemas.js';
import { changeMembership, listStaff } from './staff.service.js';

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
      return { userId: auth.userId, email: auth.email, memberships: auth.memberships };
    },
  );

  app.get(
    '/staff',
    {
      config: { access: { permission: 'staff:read' } },
      schema: { tags: ['staff'], summary: "The tenant's staff and their roles", response: { 200: staffListReply } },
    },
    async (request) => ({ staff: await withTenant(tenantContextOf(request), listStaff) }),
  );

  app.patch(
    '/staff/:membershipId',
    {
      config: {
        access: { permission: 'staff:manage' },
        audit: ['membership.role_changed', 'membership.status_changed'],
        events: ['membership.role_changed', 'membership.status_changed'],
        agentTool: { none: 'Who may do what is decided by a person, never an agent (ADR 0012)' },
      },
      schema: {
        tags: ['staff'],
        summary: "Change a staff member's role or access",
        params: membershipParams,
        body: membershipChangeBody,
        response: { 200: staffMember },
      },
    },
    async (request) =>
      withTenant(tenantContextOf(request), (tx) => changeMembership(tx, request.params.membershipId, request.body)),
  );
};
