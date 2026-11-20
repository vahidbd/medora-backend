/**
 * Clinicians: who sees patients, the credentials that let them, and when
 * they work (docs/decisions/workforce.md). The module's front door (ADR 0027).
 * Other modules ask `clinicianStanding` before booking, starting a consult or
 * prescribing; nothing else decides whether a clinician may.
 */
import type { FastifyPluginAsync } from 'fastify';
import { clinicianRoutes } from './clinicians.routes.js';
import { credentialRoutes } from './credentials.routes.js';

export { clinicianIdOf, clinicianStanding, listClinicians } from './clinicians.service.js';
export { clinicianNames } from './clinicians.store.js';
export { clinicianCalendar, hoursOf, upcomingTimeOff, type ClinicianCalendar } from './schedule.service.js';
export type { ClinicianSummary, HoursBlock, TimeOffReply } from './clinicians.schemas.js';
export { STANDING_REASONS, type Standing, type StandingReason } from './standing.js';

export const cliniciansRoutes: FastifyPluginAsync = async (app) => {
  await app.register(clinicianRoutes);
  await app.register(credentialRoutes);
};
