/**
 * Handing a conversation to a person (docs/decisions/agents.md AGT11). Every
 * way an agent stops working on a conversation ends here, with one reason
 * code. The model picks from the first eight with the hand_off tool, which
 * always runs without approval; the runtime sets the rest.
 */
export const HANDOFF_REASONS = [
  'emergency',
  'self_harm',
  'clinical',
  'distress',
  'complaint',
  'adverse_event',
  'legal',
  'patient_asked',
  'refusal',
  'limit',
  'error',
  'agent_off',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

const MODEL_REASONS = HANDOFF_REASONS.slice(0, 8);
export type ModelHandoffReason = (typeof MODEL_REASONS)[number];

/** Reasons a person must pick up before anything else. */
export const URGENT_REASONS: ReadonlySet<HandoffReason> = new Set(['emergency', 'self_harm', 'adverse_event']);

export const HAND_OFF_TOOL = {
  name: 'hand_off',
  description:
    'Pass this conversation to a person on the clinic team, and stop. Use it for anything clinical, a complaint, distress, a side effect or reaction, a legal matter, when the patient asks for a person, or when you cannot help. Write a short note of what the person needs, without personal details.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reason: { type: 'string', enum: [...MODEL_REASONS] },
      note: { type: 'string', maxLength: 500, description: 'What the person picking this up needs to know.' },
    },
    required: ['reason', 'note'],
    additionalProperties: false,
  },
};

export function modelHandoffReason(input: unknown): ModelHandoffReason {
  const reason = (input as { reason?: unknown } | null)?.reason;
  return (MODEL_REASONS as readonly string[]).includes(reason as string) ? (reason as ModelHandoffReason) : 'clinical';
}
