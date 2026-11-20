import { parseCalendarDate } from '../../lib/time.js';
import { AGE, type Condition, type Definition, type Formula, type Question, type Rule, type Step, questionIndex, referencesOf } from './definition.js';

/**
 * Running a protocol version against a person's answers
 * (docs/decisions/intake.md INT1, INT2). Pure functions: the intake module
 * calls them on the server, after every step and on submit.
 */

export type AnswerValue = boolean | number | string | string[];
export type Answers = Record<string, AnswerValue>;

export interface ShownStep {
  step: Step;
  index: number;
  questions: Question[];
}

function compute(formula: Formula, answers: Answers, derived: ReadonlyMap<string, number | null>): number | null {
  if (typeof formula === 'number') return formula;
  if ('answer' in formula) {
    const value = answers[formula.answer];
    return typeof value === 'number' ? value : null;
  }
  if ('derived' in formula) return derived.get(formula.derived) ?? null;
  const [a, b] = formula.of.map((f) => compute(f, answers, derived));
  if (a === null || a === undefined || b === null || b === undefined) return null;
  switch (formula.op) {
    case 'add':
      return a + b;
    case 'subtract':
      return a - b;
    case 'multiply':
      return a * b;
    case 'divide':
      return b === 0 ? null : a / b;
  }
}

/** The protocol's derived numbers and `age`, from the answers so far; null where an input is missing. */
export function deriveNumbers(definition: Definition, answers: Answers, age: number | null): Map<string, number | null> {
  const derived = new Map<string, number | null>([[AGE, age]]);
  for (const item of definition.derived) {
    const value = compute(item.formula, answers, derived);
    const scale = 10 ** item.decimals;
    derived.set(item.key, value === null || !Number.isFinite(value) ? null : Math.round(value * scale) / scale);
  }
  return derived;
}

/** Whether a condition holds. A comparison with an unanswered question or a missing number is false. */
export function holds(condition: Condition, answers: Answers, derived: ReadonlyMap<string, number | null>): boolean {
  if ('all' in condition) return condition.all.every((c) => holds(c, answers, derived));
  if ('any' in condition) return condition.any.some((c) => holds(c, answers, derived));
  if ('not' in condition) return !holds(condition.not, answers, derived);
  const actual: AnswerValue | null | undefined = 'answer' in condition ? answers[condition.answer] : derived.get(condition.derived);
  if (condition.is === 'answered') return actual !== undefined && actual !== null;
  if (actual === undefined || actual === null) return false;
  const expected = condition.value;
  switch (condition.is) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'less_than':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'at_most':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'greater_than':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'at_least':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'one_of':
      return Array.isArray(expected) && typeof actual === 'string' && expected.includes(actual);
    case 'includes':
      return Array.isArray(actual) && typeof expected === 'string' && actual.includes(expected);
  }
}

/**
 * The steps and questions the person sees, in order, and their answers with
 * anything no longer shown dropped. Show-if reads only earlier steps, so one
 * pass in order settles it.
 */
export function shownFlow(definition: Definition, answers: Answers, age: number | null): { steps: ShownStep[]; answers: Answers } {
  const kept: Answers = {};
  const steps: ShownStep[] = [];
  definition.steps.forEach((step, index) => {
    const derived = deriveNumbers(definition, kept, age);
    if (step.showIf && !holds(step.showIf, kept, derived)) return;
    const questions = step.questions.filter((question) => !question.showIf || holds(question.showIf, kept, derived));
    steps.push({ step, index, questions });
    for (const question of questions) {
      const value = answers[question.key];
      if (value !== undefined) kept[question.key] = value;
    }
  });
  return { steps, answers: kept };
}

export interface AnswerProblem {
  key: string;
  message: string;
}

const empty = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** Check one step's answers against the questions shown on it, and return them cleaned. */
export function readStepAnswers(questions: readonly Question[], submitted: Record<string, unknown>): { answers: Answers; problems: AnswerProblem[] } {
  const answers: Answers = {};
  const problems: AnswerProblem[] = [];
  const shown = new Set(questions.map((question) => question.key));
  for (const key of Object.keys(submitted)) if (!shown.has(key)) problems.push({ key, message: 'That isn’t a question on this step' });
  for (const question of questions) {
    const value = submitted[question.key];
    const problem = (message: string) => problems.push({ key: question.key, message });
    if (empty(value)) {
      if (question.required) problem('Answer this question');
      continue;
    }
    const options = new Set(question.options?.map((option) => option.value));
    switch (question.kind) {
      case 'yes_no':
        if (typeof value === 'boolean') answers[question.key] = value;
        else problem('Answer yes or no');
        break;
      case 'single_choice':
        if (typeof value === 'string' && options.has(value)) answers[question.key] = value;
        else problem('Choose one of the options');
        break;
      case 'multi_choice':
        if (Array.isArray(value) && value.every((v) => typeof v === 'string' && options.has(v)) && new Set(value).size === value.length) answers[question.key] = value as string[];
        else problem('Choose from the options');
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) problem('Enter a number');
        else if ((question.min !== undefined && value < question.min) || (question.max !== undefined && value > question.max)) {
          problem(`Enter a number from ${question.min ?? 'any'} to ${question.max ?? 'any'}${question.unit ? ` ${question.unit}` : ''}`);
        } else answers[question.key] = value;
        break;
      case 'date':
        if (typeof value === 'string' && parseCalendarDate(value)) answers[question.key] = value;
        else problem('Enter a date as YYYY-MM-DD');
        break;
      case 'text':
        if (typeof value === 'string' && value.trim().length <= 2000) answers[question.key] = value.trim();
        else problem('Keep it under 2,000 characters');
        break;
    }
  }
  return { answers, problems };
}

/**
 * The first hard stop that is ready and holds (INT2). A rule is ready once
 * every question it reads is on a step the person has finished, so a rule
 * never fires on an answer that isn't given yet.
 */
export function firstHardStop(definition: Definition, answers: Answers, age: number | null, stepsDone: number): Rule | null {
  const index = questionIndex(definition);
  const { answers: shown } = shownFlow(definition, answers, age);
  const derived = deriveNumbers(definition, shown, age);
  for (const rule of definition.rules) {
    if (rule.outcome !== 'hard_stop') continue;
    const ready = [...referencesOf(rule.when, definition)].every((key) => (index.get(key)?.step ?? Infinity) < stepsDone);
    if (ready && holds(rule.when, shown, derived)) return rule;
  }
  return null;
}

/** Every red flag that holds on a finished intake (INT2). */
export function redFlagsOf(definition: Definition, answers: Answers, age: number | null): Rule[] {
  const { answers: shown } = shownFlow(definition, answers, age);
  const derived = deriveNumbers(definition, shown, age);
  return definition.rules.filter((rule) => rule.outcome === 'red_flag' && holds(rule.when, shown, derived));
}

/** The first shown step with a required question unanswered, or null when the intake can be submitted. */
export function firstUnfinishedStep(definition: Definition, answers: Answers, age: number | null): Step | null {
  const flow = shownFlow(definition, answers, age);
  for (const shown of flow.steps) {
    if (shown.questions.some((question) => question.required && flow.answers[question.key] === undefined)) return shown.step;
  }
  return null;
}
