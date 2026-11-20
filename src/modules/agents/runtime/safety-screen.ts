import { createHash } from 'node:crypto';
import type { HandoffReason } from './hand-off.js';

/**
 * The safety screen (ADR 0240, docs/decisions/agents.md AGT11): plain code
 * that reads every message a patient sends, before any model does. Emergency
 * and self-harm language gets fixed words and an urgent handoff, and the
 * agent stays out of the conversation until a staff member hands it back.
 * A request for a person is honoured the same way, without the urgency.
 *
 * The terms and the words are the platform's, and part of every agent's
 * version (AGT10). Both need clinical sign-off before the first patient
 * (docs/launch-checklist.md). Matching is on whole words, case and
 * punctuation ignored, and leans towards a false alarm: a person reading a
 * conversation that didn't need them costs minutes.
 */
export const SAFETY_SCREEN_VERSION = '2026-11-20.1';

const TERMS: Readonly<Record<'emergency' | 'self_harm' | 'patient_asked', readonly string[]>> = {
  emergency: [
    'chest pain',
    'chest pains',
    'chest is tight',
    'cant breathe',
    'can not breathe',
    'cannot breathe',
    'struggling to breathe',
    'trouble breathing',
    'difficulty breathing',
    'short of breath',
    'throat is closing',
    'throat closing',
    'tongue is swelling',
    'face is swelling',
    'anaphylaxis',
    'anaphylactic',
    'overdose',
    'overdosed',
    'took too many',
    'taken too many',
    'unconscious',
    'passed out',
    'wont wake up',
    'not breathing',
    'seizure',
    'stroke',
    'face is drooping',
    'slurred speech',
    'cant feel my arm',
    'heavy bleeding',
    'bleeding heavily',
    'wont stop bleeding',
    'coughing up blood',
    'vomiting blood',
    'severe pain',
    'medical emergency',
    'this is an emergency',
    'its an emergency',
    'ambulance',
    'call 000',
  ],
  self_harm: [
    'suicide',
    'suicidal',
    'kill myself',
    'killing myself',
    'end my life',
    'ending my life',
    'end it all',
    'want to die',
    'wanna die',
    'better off dead',
    'no reason to live',
    'hurt myself',
    'hurting myself',
    'harm myself',
    'harming myself',
    'self harm',
    'selfharm',
    'cut myself',
    'cutting myself',
    'take my own life',
    'not want to be here',
    'dont want to be here anymore',
    'dont want to live',
  ],
  patient_asked: [
    'talk to a person',
    'speak to a person',
    'talk to a human',
    'speak to a human',
    'real person',
    'actual person',
    'talk to someone',
    'speak to someone',
    'talk to a doctor',
    'speak to a doctor',
    'talk to a nurse',
    'speak to a nurse',
    'human please',
    'operator',
  ],
};

/** What the patient is told, word for word. */
export const SAFETY_REPLIES: Readonly<Record<'emergency' | 'self_harm' | 'patient_asked', string>> = {
  emergency:
    'If you or someone with you is in danger or this is a medical emergency, call 000 now. We have passed your message to our team.',
  self_harm:
    "If you're thinking about harming yourself, please call Lifeline on 13 11 14 now, any time, day or night. If you are in danger right now, call 000. We have passed your message to our team.",
  patient_asked: "I'll pass you to a person on our team. They'll reply here as soon as they can.",
};

export interface ScreenResult {
  reason: Extract<HandoffReason, 'emergency' | 'self_harm' | 'patient_asked'>;
  reply: string;
}

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

const ORDER = ['self_harm', 'emergency', 'patient_asked'] as const;
const NORMALISED = Object.fromEntries(ORDER.map((reason) => [reason, TERMS[reason].map((term) => normalise(term))])) as Record<
  (typeof ORDER)[number],
  string[]
>;

/** The first match, most serious first; null when the message can go to the agent. */
export function screenMessage(text: string): ScreenResult | null {
  const haystack = normalise(text);
  for (const reason of ORDER) {
    if (NORMALISED[reason].some((term) => haystack.includes(term))) return { reason, reply: SAFETY_REPLIES[reason] };
  }
  return null;
}

/** Part of every agent's version: a change to the terms or the words is a new version. */
export const SAFETY_SCREEN_FINGERPRINT = {
  version: SAFETY_SCREEN_VERSION,
  hash: createHash('sha256').update(JSON.stringify({ TERMS, SAFETY_REPLIES })).digest('hex').slice(0, 16),
};
