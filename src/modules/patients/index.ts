/**
 * Patients: the identity part of the record, patient accounts and patient
 * sign-in (docs/decisions/patients.md). The module's front door (ADR 0027).
 * Every read below writes its own audit entry.
 */
import type { FastifyPluginAsync } from 'fastify';
import { consentsRoutes } from './consents.routes.js';
import { identityRoutes } from './identity.routes.js';
import { patientAccountRoutes } from './patient-account.routes.js';
import { patientsRoutes } from './patients.routes.js';

export const patientRoutes: FastifyPluginAsync = async (app) => {
  await app.register(patientAccountRoutes);
  await app.register(patientsRoutes);
  await app.register(consentsRoutes);
  await app.register(identityRoutes);
};

export { assertConsents, consentsNeeded, type ConsentPurpose } from './consents.service.js';
export { assertIdentityVerified, isIdentityVerified } from './identity.service.js';

export {
  findPatient,
  findPatientContact,
  findPatients,
  findPatientsByContact,
  getPatientForPrescribing,
  type PatientAddress,
  type PatientContact,
  type PatientSummary,
  type PrescribingPatient,
} from './patients.service.js';
export { ageOn, MINIMUM_AGE, normaliseEmail, normaliseMobile } from './patient-details.js';
