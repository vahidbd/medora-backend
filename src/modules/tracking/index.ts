/**
 * Tracking: what a patient tells their care team between consults
 * (measurements, side effects, check-ins; docs/decisions/tracking.md). The
 * module's front door (ADR 0027). Every read below writes its own audit
 * entry; every write, its audit entry and event.
 */
export { trackingRoutes } from './tracking.routes.js';
export { checkInsOf } from './check-ins.service.js';
export { measurementsOf, recordMeasurements } from './measurements.service.js';
export { reportSideEffect, sideEffectsOf } from './side-effects.service.js';
export type { CheckIn, Measurement, SideEffect } from './tracking.schemas.js';
