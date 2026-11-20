import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { requireTenant, tenantContextOf } from '../../plugins/auth.js';
import { customRole, roleDeletedReply, roleInput, roleParams, rolesReply, roleUpdate } from './roles.schemas.js';
import { createRole, deleteRole, listRoles, updateRole } from './roles.service.js';

const NO_AGENT = { none: 'AI can never change permissions (PRD ADM-07, docs/decisions/admin.md ADM4)' } as const;

export const roleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/roles',
    {
      config: { access: { permission: 'staff:read' } },
      schema: { tags: ['staff'], summary: 'The starting roles, the tenant’s custom roles, and every permission', response: { 200: rolesReply } },
    },
    async (request) => withTenant(tenantContextOf(request), listRoles),
  );

  app.post(
    '/roles',
    {
      config: { access: { permission: 'roles:manage' }, audit: ['role.created'], events: ['role.created'], agentTool: NO_AGENT },
      schema: { tags: ['staff'], summary: 'Make a custom role from a starting role', body: roleInput, response: { 201: customRole } },
    },
    async (request, reply) => {
      const { tenant } = requireTenant(request);
      const role = await withTenant(tenantContextOf(request), (tx) => createRole(tx, tenant, request.body));
      return reply.code(201).send(role);
    },
  );

  app.patch(
    '/roles/:roleId',
    {
      config: { access: { permission: 'roles:manage' }, audit: ['role.changed'], events: ['role.changed'], agentTool: NO_AGENT },
      schema: { tags: ['staff'], summary: 'Change a custom role', params: roleParams, body: roleUpdate, response: { 200: customRole } },
    },
    async (request) => {
      const { tenant } = requireTenant(request);
      return withTenant(tenantContextOf(request), (tx) => updateRole(tx, tenant, request.params.roleId, request.body));
    },
  );

  app.delete(
    '/roles/:roleId',
    {
      config: { access: { permission: 'roles:manage' }, audit: ['role.deleted'], events: ['role.deleted'], agentTool: NO_AGENT },
      schema: { tags: ['staff'], summary: 'Delete a custom role nobody has', params: roleParams, response: { 200: roleDeletedReply } },
    },
    async (request) => {
      const { tenant } = requireTenant(request);
      await withTenant(tenantContextOf(request), (tx) => deleteRole(tx, tenant, request.params.roleId));
      return { roleId: request.params.roleId };
    },
  );
};
