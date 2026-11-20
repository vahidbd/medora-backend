/**
 * Adherence: what the patient did, and the adherence flags the care team
 * looks at (PRD 12, docs/decisions/adherence.md, ADR 0260). The module's
 * front door (ADR 0027). Modules that record a patient's action call
 * recordActivity in the same transaction; rules that spot a risk raise their
 * flag the same way.
 */
export { adherenceRoutes } from './adherence.routes.js';
export { activityOf, recordActivity, type Activity, type ActivitySource } from './activity.service.js';
export { flagSideEffect, openFlagsOf, type OpenAdherenceFlag } from './flags.service.js';
