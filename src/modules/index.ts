import type { FastifyPluginAsync } from 'fastify';
import { staffRoutes } from './staff/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
};
