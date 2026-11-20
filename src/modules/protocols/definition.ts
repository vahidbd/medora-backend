import { z } from 'zod';

/**
 * The shape of a protocol version (docs/decisions/intake.md INT1, INT2):
 * steps of questions, derived numbers and rules, all data (ADR 0023). The
 * rule language is conditions over answers with all, any, not and
 * comparisons; derived numbers are small arithmetic over number answers,
 * with `age` the one built-in. Free text never drives a rule, there is no
 * scripting, and everything runs on the server.
 */

export const QUESTION_KINDS = ['yes_no', 'single_choice', 'multi_choice', 'number', 'date', 'text'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const RULE_OUTCOMES = ['hard_stop', 'red_flag'] as const;
export const COMPARISONS = ['equals', 'not_equals', 'less_than', 'at_most', 'greater_than', 'at_least', 'one_of', 'includes', 'answered'] as const;
export type Comparison = (typeof COMPARISONS)[number];

/** The one built-in number: whole years from the date of birth given at the start, on the day of answering. */
export const AGE = 'age';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'Use lower-case letters, digits and underscores, starting with a letter');
const words = (max: number) => z.string().trim().min(1).max(max);

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { answer: string; is: Comparison; value?: boolean | number | string | string[] }
  | { derived: string; is: Comparison; value?: number };

const conditionValue = z.union([z.boolean(), z.number().finite(), key, z.array(key).min(1).max(30)]);
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ answer: key, is: z.enum(COMPARISONS), value: conditionValue.optional() }).strict(),
    z.object({ derived: key, is: z.enum(COMPARISONS), value: z.number().finite().optional() }).strict(),
  ]),
);

export type Formula = number | { answer: string } | { derived: string } | { op: 'add' | 'subtract' | 'multiply' | 'divide'; of: [Formula, Formula] };
export const formulaSchema: z.ZodType<Formula> = z.lazy(() =>
  z.union([
    z.number().finite(),
    z.object({ answer: key }).strict(),
    z.object({ derived: key }).strict(),
    z.object({ op: z.enum(['add', 'subtract', 'multiply', 'divide']), of: z.tuple([formulaSchema, formulaSchema]) }).strict(),
  ]),
);

const optionSchema = z.object({ value: key, label: words(200) }).strict();

export const questionSchema = z
  .object({
    key,
    label: words(300),
    help: words(1000).optional(),
    kind: z.enum(QUESTION_KINDS),
    required: z.boolean().default(true),
    options: z.array(optionSchema).min(2).max(30).optional(),
    unit: words(20).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    /** Shown only when this holds, judged on answers from earlier steps. */
    showIf: conditionSchema.optional(),
  })
  .strict();
export type Question = z.infer<typeof questionSchema>;

export const stepSchema = z
  .object({ key, title: words(120), intro: words(1000).optional(), showIf: conditionSchema.optional(), questions: z.array(questionSchema).min(1).max(30) })
  .strict();
export type Step = z.infer<typeof stepSchema>;

export const derivedSchema = z.object({ key, label: words(120), unit: words(20).optional(), decimals: z.number().int().min(0).max(3).default(1), formula: formulaSchema }).strict();
export type Derived = z.infer<typeof derivedSchema>;

export const ruleSchema = z
  .object({
    key,
    outcome: z.enum(RULE_OUTCOMES),
    when: conditionSchema,
    /** What the prescriber sees. Never shown to the patient. */
    prescriberLabel: words(200),
    /** What the patient sees when a hard stop ends their intake: plain words, no diagnosis. */
    patientMessage: words(1000).optional(),
    /** Show the urgent-help message (000 and crisis lines) with the hard stop. */
    urgentHelp: z.boolean().default(false),
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;

export const definitionSchema = z
  .object({
    steps: z.array(stepSchema).min(1).max(40),
    derived: z.array(derivedSchema).max(20).default([]),
    rules: z.array(ruleSchema).max(100).default([]),
  })
  .strict();
export type Definition = z.infer<typeof definitionSchema>;

export interface DefinitionProblem {
  path: string;
  message: string;
}

const COMPARES_FOR: Record<QuestionKind | 'number_value', readonly Comparison[]> = {
  yes_no: ['equals', 'not_equals', 'answered'],
  single_choice: ['equals', 'not_equals', 'one_of', 'answered'],
  multi_choice: ['includes', 'answered'],
  number: ['equals', 'not_equals', 'less_than', 'at_most', 'greater_than', 'at_least', 'answered'],
  date: ['answered'],
  text: [],
  number_value: ['equals', 'not_equals', 'less_than', 'at_most', 'greater_than', 'at_least', 'answered'],
};

/** Every question key, with its step's position and the question. */
export function questionIndex(definition: Definition): Map<string, { step: number; question: Question }> {
  const index = new Map<string, { step: number; question: Question }>();
  definition.steps.forEach((step, position) => {
    for (const question of step.questions) index.set(question.key, { step: position, question });
  });
  return index;
}

/** The question keys a condition reads, directly or through derived numbers. */
export function referencesOf(condition: Condition, definition: Definition): Set<string> {
  const found = new Set<string>();
  const derived = new Map(definition.derived.map((d) => [d.key, d]));
  const formula = (f: Formula): void => {
    if (typeof f === 'number') return;
    if ('answer' in f) found.add(f.answer);
    else if ('derived' in f) {
      const d = derived.get(f.derived);
      if (d) formula(d.formula);
    } else f.of.forEach(formula);
  };
  const walk = (c: Condition): void => {
    if ('all' in c) c.all.forEach(walk);
    else if ('any' in c) c.any.forEach(walk);
    else if ('not' in c) walk(c.not);
    else if ('answer' in c) found.add(c.answer);
    else if (c.derived !== AGE) {
      const d = derived.get(c.derived);
      if (d) formula(d.formula);
    }
  };
  walk(condition);
  return found;
}

/**
 * Check what the shape alone can't: keys are unique, every reference
 * exists and comes earlier, comparisons suit the question, free text drives
 * nothing, and a hard stop tells the patient why.
 */
export function definitionProblems(definition: Definition): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const add = (path: string, message: string): void => {
    problems.push({ path, message });
  };
  const seen = new Set<string>([AGE]);
  const claim = (keyName: string, path: string) => {
    if (seen.has(keyName)) add(path, `The key "${keyName}" is used twice`);
    seen.add(keyName);
  };
  const questions = questionIndex(definition);
  const derivedKeys = new Set<string>([AGE]);

  const checkCondition = (condition: Condition, path: string, beforeStep: number, depth = 0): void => {
    if (depth > 6) return add(path, 'Conditions nest too deep');
    if ('all' in condition) return condition.all.forEach((c, i) => checkCondition(c, `${path}.all.${i}`, beforeStep, depth + 1));
    if ('any' in condition) return condition.any.forEach((c, i) => checkCondition(c, `${path}.any.${i}`, beforeStep, depth + 1));
    if ('not' in condition) return checkCondition(condition.not, `${path}.not`, beforeStep, depth + 1);
    if ('derived' in condition) {
      if (!derivedKeys.has(condition.derived)) return add(path, `No derived number "${condition.derived}" is defined before this`);
      if (!COMPARES_FOR.number_value.includes(condition.is)) return add(path, `A number can't be compared with "${condition.is}"`);
      if (condition.is !== 'answered' && typeof condition.value !== 'number') add(path, 'Compare a number with a number');
      for (const ref of referencesOf(condition, definition)) {
        if ((questions.get(ref)?.step ?? Infinity) >= beforeStep) add(path, `"${condition.derived}" uses "${ref}", which isn't answered before this`);
      }
      return;
    }
    const target = questions.get(condition.answer);
    if (!target) return add(path, `No question "${condition.answer}"`);
    if (target.step >= beforeStep) return add(path, `"${condition.answer}" isn't answered before this`);
    const kind = target.question.kind;
    if (kind === 'text') return add(path, 'Free text never drives a rule or a show-if');
    if (!COMPARES_FOR[kind].includes(condition.is)) return add(path, `A ${kind} answer can't be compared with "${condition.is}"`);
    if (condition.is === 'answered') return;
    const values = new Set(target.question.options?.map((option) => option.value) ?? []);
    const value = condition.value;
    if (kind === 'yes_no' && typeof value !== 'boolean') add(path, 'Compare a yes or no answer with true or false');
    if (kind === 'number' && typeof value !== 'number') add(path, 'Compare a number with a number');
    if ((kind === 'single_choice' && condition.is !== 'one_of') || kind === 'multi_choice') {
      if (typeof value !== 'string' || !values.has(value)) add(path, `"${String(value)}" isn't one of the options`);
    }
    if (kind === 'single_choice' && condition.is === 'one_of') {
      if (!Array.isArray(value) || value.some((v) => !values.has(v))) add(path, 'List only the question’s own options');
    }
  };

  const checkFormula = (formula: Formula, path: string): void => {
    if (typeof formula === 'number') return;
    if ('answer' in formula) {
      if (questions.get(formula.answer)?.question.kind !== 'number') add(path, `"${formula.answer}" isn't a number question`);
      return;
    }
    if ('derived' in formula) {
      if (!derivedKeys.has(formula.derived)) add(path, `No derived number "${formula.derived}" is defined before this`);
      return;
    }
    formula.of.forEach((f, i) => checkFormula(f, `${path}.of.${i}`));
  };

  definition.derived.forEach((derived, d) => {
    claim(derived.key, `derived.${d}.key`);
    checkFormula(derived.formula, `derived.${d}.formula`);
    derivedKeys.add(derived.key);
  });
  definition.steps.forEach((step, s) => {
    claim(step.key, `steps.${s}.key`);
    if (step.showIf) checkCondition(step.showIf, `steps.${s}.showIf`, s);
    step.questions.forEach((question, q) => {
      const path = `steps.${s}.questions.${q}`;
      claim(question.key, `${path}.key`);
      const choice = question.kind === 'single_choice' || question.kind === 'multi_choice';
      if (choice && !question.options) add(`${path}.options`, 'A choice question needs options');
      if (!choice && question.options) add(`${path}.options`, 'Only choice questions have options');
      if (question.options && new Set(question.options.map((o) => o.value)).size !== question.options.length) add(`${path}.options`, 'Option values must differ');
      if (question.kind !== 'number' && (question.min !== undefined || question.max !== undefined || question.unit !== undefined)) {
        add(path, 'Only number questions have a unit, min or max');
      }
      if (question.min !== undefined && question.max !== undefined && question.min > question.max) add(path, 'min is above max');
      if (question.showIf) checkCondition(question.showIf, `${path}.showIf`, s);
    });
  });
  definition.rules.forEach((rule, r) => {
    claim(rule.key, `rules.${r}.key`);
    checkCondition(rule.when, `rules.${r}.when`, definition.steps.length);
    if (rule.outcome === 'hard_stop' && !rule.patientMessage) add(`rules.${r}.patientMessage`, 'A hard stop needs a message for the patient');
    if (rule.outcome === 'red_flag' && (rule.patientMessage || rule.urgentHelp)) add(`rules.${r}`, 'A red flag is never shown to the patient');
  });
  return problems;
}
