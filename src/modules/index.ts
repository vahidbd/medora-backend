import type { FastifyPluginAsync } from 'fastify';
import { agentRoutes } from './agents/index.js';
import { staffRoutes } from './staff/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(agentRoutes);
};
