import type { FastifyPluginAsync } from "fastify";
import { notificationPreferencesRoutes } from "./notification-preferences/index.js";
import { patientRoutes } from "./patients/index.js";
import { protocolsRoutes } from "./protocols/index.js";
import { tenantSetupRoutes } from "./brands/index.js";
import { staffRoutes } from "./staff/index.js";
import { trackingRoutes } from "./tracking/index.js";

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(patientRoutes);
  await app.register(protocolsRoutes);
  await app.register(tenantSetupRoutes);
  await app.register(trackingRoutes);
  await app.register(notificationPreferencesRoutes);
};
