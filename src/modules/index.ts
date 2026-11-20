import type { FastifyPluginAsync } from 'fastify';
import { tenantSetupRoutes } from './brands/index.js';
import { messagingRoutes, registerDeliveryWebhooks } from './messaging/index.js';
import { patientRoutes } from './patients/index.js';
import { staffRoutes } from './staff/index.js';
import { registerSupportWebhooks, supportRoutes } from './support/index.js';
import { telephonyRoutes } from './telephony/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(telephonyRoutes);
  await app.register(patientRoutes);
  await app.register(tenantSetupRoutes);
  registerDeliveryWebhooks();
  registerSupportWebhooks();
  await app.register(messagingRoutes);
  await app.register(supportRoutes);
};
