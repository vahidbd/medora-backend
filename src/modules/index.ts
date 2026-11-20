import type { FastifyPluginAsync } from 'fastify';
import { prescribingRoutes } from './prescribing/index.js';
import { staffRoutes } from './staff/index.js';
import { telephonyRoutes } from './telephony/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(telephonyRoutes);
  await app.register(prescribingRoutes);
};
