/**
 * Intakes (docs/decisions/intake.md INT5 to INT15): a person answering a
 * program's questions before a consult, the rules run on each step, and the
 * prescriber's summary. The module's front door (ADR 0027).
 */
export { intakeRoutes } from './intake.routes.js';
export { type IntakeSummary, intakeSummaryFor, type PatientProgram, programsOfPatient } from './summary.service.js';
export { settleIntakes } from './upkeep.js';
