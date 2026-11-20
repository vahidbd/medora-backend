import type { FastifyPluginAsync } from 'fastify';
import { patientRoutes } from './patients/index.js';
import { protocolsRoutes } from './protocols/index.js';
import { staffRoutes } from './staff/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(patientRoutes);
  await app.register(protocolsRoutes);
};
