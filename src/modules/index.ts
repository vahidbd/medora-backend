import type { FastifyPluginAsync } from 'fastify';
import { cliniciansRoutes } from './clinicians/index.js';
import { consultRoutes } from './consults/index.js';
import { intakeRoutes, programsOfPatient } from './intake/index.js';
import { patientRoutes } from './patients/index.js';
import { protocolsRoutes } from './protocols/index.js';
import { tenantSetupRoutes } from './brands/index.js';
import { staffRoutes } from './staff/index.js';
import { telephonyRoutes } from './telephony/index.js';

/** Every module's routes, under /v1. */
export const registerModules: FastifyPluginAsync = async (app) => {
  await app.register(staffRoutes);
  await app.register(cliniciansRoutes);
  await app.register(telephonyRoutes);
  await app.register(patientRoutes, { programsOf: programsOfPatient });
  await app.register(protocolsRoutes);
  await app.register(intakeRoutes);
  await app.register(tenantSetupRoutes);
  await app.register(consultRoutes);
};
