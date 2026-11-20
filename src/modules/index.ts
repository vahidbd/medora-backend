import type { FastifyPluginAsync } from 'fastify';
import { auditRoutes } from './audit/index.js';
import { tenantSetupRoutes } from './brands/index.js';
import { catalogueRoutes } from './catalogue/index.js';
import { staffRoutes } from './staff/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(tenantSetupRoutes);
  await app.register(catalogueRoutes);
  await app.register(auditRoutes);
};
