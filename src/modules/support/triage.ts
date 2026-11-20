import type { TicketFlag } from '../../db/schema/values.js';

/**
 * Triage of every message a person sends in (docs/decisions/support.md SUP3).
 * Word lists, no model: the same text always gives the same answer, and a
 * list can be read and reviewed. The lists are the platform's floor; a
 * tenant can't remove a word from them.
 *
 * Pure: no database, so the tests and the inbound path share one rule.
 */

type Rule = {
  flag: Extract<TicketFlag, 'emergency' | 'self_harm' | 'clinical' | 'possible_adverse_event' | 'possible_complaint' | 'legal' | 'person_requested'>;
  phrases: readonly string[];
};

const RULES: readonly Rule[] = [
  {
    flag: 'emergency',
    phrases: [
      'chest pain',
      'chest pains',
      "can't breathe",
      'cant breathe',
      'cannot breathe',
      'can not breathe',
      'trouble breathing',
      'difficulty breathing',
      'struggling to breathe',
      'short of breath',
      'unconscious',
      'passed out',
      'collapsed',
      'seizure',
      'fitting',
      'overdose',
      'overdosed',
      'stroke',
      'anaphylaxis',
      'anaphylactic',
      'throat is swelling',
      'throat swelling',
      'severe bleeding',
      'bleeding heavily',
      'ambulance',
      'call 000',
      'emergency',
    ],
  },
  {
    flag: 'self_harm',
    phrases: [
      'suicide',
      'suicidal',
      'kill myself',
      'killing myself',
      'end my life',
      'ending my life',
      'take my own life',
      'self harm',
      'self-harm',
      'selfharm',
      'hurt myself',
      'hurting myself',
      'harm myself',
      'cutting myself',
      'want to die',
      'wanna die',
      "don't want to be alive",
      'dont want to be alive',
      "don't want to live",
      'dont want to live',
      'no reason to live',
      'better off dead',
      'better off without me',
    ],
  },
  {
    flag: 'clinical',
    phrases: [
      'side effect',
      'side effects',
      'dosage',
      'missed a dose',
      'missed my dose',
      'wrong dose',
      'double dose',
      'change my dose',
      'increase my dose',
      'lower my dose',
      'symptom',
      'symptoms',
      'pregnant',
      'pregnancy',
      'breastfeeding',
      'nausea',
      'nauseous',
      'vomit',
      'vomiting',
      'throwing up',
      'diarrhoea',
      'diarrhea',
      'constipation',
      'pain',
      'painful',
      'rash',
      'dizzy',
      'dizziness',
      'headache',
      'headaches',
      'faint',
      'fainted',
      'fainting',
      'injection site',
      'blood pressure',
      'blood sugar',
      'heart racing',
      'palpitations',
      'drug interaction',
      'mental health',
      'depressed',
      'anxious',
      'anxiety',
    ],
  },
  {
    flag: 'possible_adverse_event',
    phrases: [
      'allergic',
      'allergy',
      'reaction',
      'reacted',
      'hives',
      'swelling',
      'swollen',
      'hospital',
      'hospitalised',
      'hospitalized',
      'emergency department',
      'admitted',
      'pancreatitis',
      'gallbladder',
      'jaundice',
    ],
  },
  {
    flag: 'possible_complaint',
    phrases: [
      'complaint',
      'complain',
      'complaining',
      'unhappy',
      'not happy',
      'disgusted',
      'disgusting',
      'unacceptable',
      'appalling',
      'ombudsman',
      'ahpra',
      'hccc',
      'health complaints',
      'terrible service',
      'worst service',
      'rip off',
      'ripoff',
      'scam',
      'report you',
      'reporting you',
      'chargeback',
    ],
  },
  {
    flag: 'legal',
    phrases: ['lawyer', 'lawyers', 'solicitor', 'legal action', 'sue', 'suing', 'court', 'tribunal', 'class action', 'accc', 'fair trading'],
  },
  {
    // AIP-08: a person can reach a human at any time; the agent stops on this ticket (SUP12).
    flag: 'person_requested',
    phrases: [
      'speak to a person',
      'talk to a person',
      'speak to someone',
      'talk to someone',
      'speak to a human',
      'talk to a human',
      'real person',
      'a human',
      'not a bot',
      'are you a bot',
      'speak to a doctor',
      'talk to a doctor',
      'speak to a nurse',
      'talk to a nurse',
      'call me',
      'phone me',
      'ring me',
    ],
  },
];

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

function contains(haystack: string, phrase: string): boolean {
  return haystack.includes(` ${phrase} `);
}

export interface Triage {
  /** Every flag whose words appear, in the order of RULES. */
  flags: TicketFlag[];
  /** The ticket goes to the clinical queue. */
  clinical: boolean;
  /** The ticket is urgent, and the person gets the safety reply at once. */
  urgent: boolean;
}

export function triage(...texts: (string | null | undefined)[]): Triage {
  const text = normalise(texts.filter(Boolean).join(' \n '));
  const flags = RULES.filter((rule) => rule.phrases.some((phrase) => contains(text, phrase))).map((rule) => rule.flag);
  const urgent = flags.includes('emergency') || flags.includes('self_harm');
  const clinical = urgent || flags.includes('clinical') || flags.includes('possible_adverse_event');
  return { flags, clinical, urgent };
}

/**
 * The automatic reply to an emergency or self-harm message (SUP4). Platform
 * wording: a tenant can't edit it or turn it off. It says it is automatic.
 */
export const SAFETY_REPLY =
  'This is an automatic reply. If you or someone else is in danger, or this is a medical emergency, call 000 now. ' +
  'If you are thinking about suicide or self-harm, call Lifeline on 13 11 14 (any time) or text 0477 13 11 14. ' +
  'Do not wait for our reply. A member of our clinical team will read your message.';

export const SAFETY_REPLY_SUBJECT = 'We have your message';
