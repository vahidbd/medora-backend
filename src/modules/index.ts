import type { FastifyPluginAsync } from 'fastify';
import { auditRoutes } from './audit/index.js';
import { intakeRoutes, programsOfPatient } from './intake/index.js';
import { notificationPreferencesRoutes } from './notification-preferences/index.js';
import { patientRoutes } from './patients/index.js';
import { protocolsRoutes } from './protocols/index.js';
import { tenantSetupRoutes } from './brands/index.js';
import { catalogueRoutes } from './catalogue/index.js';
import { staffRoutes } from './staff/index.js';
import { trackingRoutes } from './tracking/index.js';
import { adherenceRoutes } from './adherence/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(patientRoutes, { programsOf: programsOfPatient });
  await app.register(protocolsRoutes);
  await app.register(intakeRoutes);
  await app.register(tenantSetupRoutes);
  await app.register(catalogueRoutes);
  await app.register(auditRoutes);
  await app.register(trackingRoutes);
  await app.register(notificationPreferencesRoutes);
  await app.register(adherenceRoutes);
};
