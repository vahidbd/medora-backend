/**
 * Prescribing: opening Parchment after a consult (docs/decisions/prescribing.md).
 * The module's front door (ADR 0027).
 */
export { prescribingRoutes } from './prescribing.routes.js';
export { connectPrescribing, type PrescribingDependencies, type PrescribingPatient, type QualifyingConsult } from './ports.js';
export { fakeParchment } from './parchment/fake.js';
