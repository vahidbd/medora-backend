import { describe, expect, it } from 'vitest';
import { type Definition, definitionProblems, definitionSchema } from '../../src/modules/protocols/definition.js';
import { deriveNumbers, firstHardStop, firstUnfinishedStep, readStepAnswers, redFlagsOf, shownFlow } from '../../src/modules/protocols/rules.js';

/** The protocol rule language (docs/decisions/intake.md INT1, INT2), on a made-up condition. */

const definition: Definition = definitionSchema.parse({
  steps: [
    {
      key: 'body',
      title: 'About you',
      questions: [
        { key: 'height', label: 'Height', kind: 'number', unit: 'cm', min: 100, max: 250 },
        { key: 'mass', label: 'Mass', kind: 'number', unit: 'kg', min: 30, max: 300 },
        { key: 'expecting', label: 'Are you expecting?', kind: 'yes_no' },
      ],
    },
    {
      key: 'history',
      title: 'History',
      questions: [
        { key: 'conditions', label: 'Any of these?', kind: 'multi_choice', required: false, options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }] },
        { key: 'beta_since', label: 'Since when?', kind: 'date', showIf: { answer: 'expecting', is: 'equals', value: false } },
        { key: 'notes', label: 'Anything else?', kind: 'text', required: false },
      ],
    },
    {
      key: 'extra',
      title: 'Only for some',
      showIf: { derived: 'index', is: 'at_least', value: 30 },
      questions: [{ key: 'tried', label: 'Tried before?', kind: 'single_choice', options: [{ value: 'never', label: 'Never' }, { value: 'once', label: 'Once' }] }],
    },
  ],
  derived: [{ key: 'index', label: 'Index', decimals: 1, formula: { op: 'divide', of: [{ op: 'multiply', of: [{ answer: 'mass' }, 10000] }, { op: 'multiply', of: [{ answer: 'height' }, { answer: 'height' }] }] } }],
  rules: [
    { key: 'expecting_stop', outcome: 'hard_stop', when: { answer: 'expecting', is: 'equals', value: true }, prescriberLabel: 'Expecting', patientMessage: 'This service isn’t right for you now.' },
    { key: 'too_old', outcome: 'hard_stop', when: { derived: 'age', is: 'greater_than', value: 75 }, prescriberLabel: 'Over 75', patientMessage: 'Please see your GP.' },
    {
      key: 'low_index',
      outcome: 'hard_stop',
      when: { all: [{ derived: 'index', is: 'less_than', value: 27 }, { not: { answer: 'conditions', is: 'includes', value: 'alpha' } }] },
      prescriberLabel: 'Index under 27 without alpha',
      patientMessage: 'This program needs a higher index.',
    },
    { key: 'beta_flag', outcome: 'red_flag', when: { answer: 'conditions', is: 'includes', value: 'beta' }, prescriberLabel: 'Has beta' },
  ],
});

describe('checking a definition', () => {
  it('accepts a sound one', () => {
    expect(definitionProblems(definition)).toEqual([]);
  });

  it('refuses free text driving a rule, references to later steps, unknown options and a silent hard stop', () => {
    const broken = definitionSchema.parse({
      ...definition,
      steps: [
        { ...definition.steps[0], questions: [...definition.steps[0]!.questions, { key: 'early', label: 'Early', kind: 'yes_no', showIf: { answer: 'notes', is: 'answered' } }] },
        ...definition.steps.slice(1),
      ],
      rules: [
        { key: 'by_text', outcome: 'red_flag', when: { answer: 'notes', is: 'answered' }, prescriberLabel: 'x' },
        { key: 'bad_option', outcome: 'red_flag', when: { answer: 'conditions', is: 'includes', value: 'gamma' }, prescriberLabel: 'x' },
        { key: 'silent', outcome: 'hard_stop', when: { answer: 'expecting', is: 'equals', value: true }, prescriberLabel: 'x' },
        { key: 'height', outcome: 'red_flag', when: { answer: 'expecting', is: 'equals', value: true }, prescriberLabel: 'x' },
      ],
    });
    const messages = definitionProblems(broken).map((problem) => problem.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        '"notes" isn\'t answered before this',
        'Free text never drives a rule or a show-if',
        '"gamma" isn\'t one of the options',
        'A hard stop needs a message for the patient',
        'The key "height" is used twice',
      ]),
    );
  });
});

describe('running a definition', () => {
  it('works out derived numbers, and leaves them empty until their answers exist', () => {
    expect(deriveNumbers(definition, { height: 170, mass: 95 }, 40).get('index')).toBe(32.9);
    expect(deriveNumbers(definition, { height: 170 }, 40).get('index')).toBeNull();
  });

  it('shows a step or question only when its condition holds, and drops answers no longer shown', () => {
    const answers = { height: 170, mass: 70, expecting: true, beta_since: '2020-01-01', tried: 'once' };
    const flow = shownFlow(definition, answers, 40);
    expect(flow.steps.map((s) => s.step.key)).toEqual(['body', 'history']);
    expect(flow.steps[1]!.questions.map((q) => q.key)).toEqual(['conditions', 'notes']);
    expect(flow.answers).toEqual({ height: 170, mass: 70, expecting: true });
  });

  it('fires a hard stop only once every question it reads is behind the person', () => {
    const answers = { height: 170, mass: 70, expecting: false };
    expect(firstHardStop(definition, answers, 40, 1)).toBeNull();
    expect(firstHardStop(definition, { ...answers, conditions: [] }, 40, 2)?.key).toBe('low_index');
    expect(firstHardStop(definition, { ...answers, conditions: ['alpha'] }, 40, 2)).toBeNull();
    expect(firstHardStop(definition, { ...answers, expecting: true }, 40, 1)?.key).toBe('expecting_stop');
    expect(firstHardStop(definition, answers, 80, 0)?.key).toBe('too_old');
  });

  it('lists every red flag that holds', () => {
    expect(redFlagsOf(definition, { height: 170, mass: 95, expecting: false, conditions: ['alpha', 'beta'] }, 40).map((rule) => rule.key)).toEqual(['beta_flag']);
  });

  it('finds the first step with a required answer missing', () => {
    expect(firstUnfinishedStep(definition, { height: 170, mass: 95, expecting: false }, 40)?.key).toBe('history');
    expect(firstUnfinishedStep(definition, { height: 170, mass: 95, expecting: false, beta_since: '2020-01-01', tried: 'never' }, 40)).toBeNull();
  });

  it('checks one step’s answers against its questions', () => {
    const [body] = shownFlow(definition, {}, 40).steps;
    expect(readStepAnswers(body!.questions, { height: 170, mass: 20, expecting: 'no', extra: 1 }).problems).toEqual([
      { key: 'extra', message: 'That isn’t a question on this step' },
      { key: 'mass', message: 'Enter a number from 30 to 300 kg' },
      { key: 'expecting', message: 'Answer yes or no' },
    ]);
    expect(readStepAnswers(body!.questions, { height: 170, mass: 80, expecting: false })).toEqual({ answers: { height: 170, mass: 80, expecting: false }, problems: [] });
  });
});
