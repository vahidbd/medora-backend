import type { FastifyPluginAsync } from 'fastify';
import { ledgerRoutes } from './ledger/index.js';
import { paymentAccountRoutes } from './payments/index.js';
import { staffRoutes } from './staff/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(ledgerRoutes);
  await app.register(paymentAccountRoutes);
};
