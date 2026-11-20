/**
 * Protocols and programs (docs/decisions/intake.md): a tenant's clinical
 * rules as signed-off versions, and the programs brands sell on them. The
 * module's front door (ADR 0027).
 */
export { protocolsRoutes } from './protocols.routes.js';
export { getProgram, listPrograms, type Program } from './programs.service.js';
export { liveVersionOf } from './protocols.service.js';
export type { Definition, Question, Rule, Step } from './definition.js';
export {
  type AnswerProblem,
  type Answers,
  type AnswerValue,
  deriveNumbers,
  firstHardStop,
  firstUnfinishedStep,
  readStepAnswers,
  redFlagsOf,
  shownFlow,
} from './rules.js';
