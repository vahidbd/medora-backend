import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { breakGlassRoutes } from './break-glass.routes.js';
import { roleRoutes } from './roles.routes.js';
import { staffRoutes as memberRoutes } from './staff.routes.js';

/** Staff access: who works in a tenant, with which role, invitations, two-step sign-in and break-glass. The module's front door (ADR 0027). */
export const staffRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(memberRoutes);
  await app.register(roleRoutes);
  await app.register(breakGlassRoutes);
};
