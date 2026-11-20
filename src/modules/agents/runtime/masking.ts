import { maskText } from '../../../lib/redact.js';

/**
 * Masking before the model (ADR 0037, docs/decisions/agents.md AGT9). Patient
 * text and tool results lose email addresses and long numbers (phone,
 * Medicare and card numbers) by pattern, and every value the clinic holds
 * for the patient (name, contact details, address, date of birth) by exact
 * match, longest first. What is stored in the transcript is the masked
 * text, so a replayed conversation is byte for byte what the model saw.
 */
export interface KnownValue {
  value: string;
  /** What the model sees instead, e.g. `name`, `address`, `date of birth`. */
  label: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskForModel(text: string, known: readonly KnownValue[] = []): string {
  let masked = text;
  const values = known.filter((k) => k.value.trim().length >= 2).sort((a, b) => b.value.length - a.value.length);
  for (const { value, label } of values) {
    masked = masked.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value.trim())}(?![\\p{L}\\p{N}])`, 'giu'), `[${label}]`);
  }
  return maskText(masked);
}

/**
 * Fields of a tool's reply that say who the patient is or how to reach
 * them. Their values never reach the model, whichever route sent them, so
 * routes name other things under other keys (`productName`, not `name`).
 */
const IDENTITY_KEYS: Readonly<Record<string, string>> = {
  name: 'name',
  firstName: 'name',
  lastName: 'name',
  fullName: 'name',
  preferredName: 'name',
  email: 'email',
  phone: 'phone',
  mobile: 'phone',
  address: 'address',
  dateOfBirth: 'date of birth',
  medicareNumber: 'Medicare number',
  ihi: 'IHI',
};

function maskIdentityFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskIdentityFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, Object.hasOwn(IDENTITY_KEYS, key) && inner !== null ? `[${IDENTITY_KEYS[key]}]` : maskIdentityFields(inner)]),
  );
}

/** A tool's reply as the model sees it: identity fields and patterns masked, and cut short when it is long. */
export function maskToolResult(body: unknown, known: readonly KnownValue[] = [], limit = 20_000): string {
  const text = typeof body === 'string' ? body : JSON.stringify(maskIdentityFields(body));
  const masked = maskForModel(text, known);
  return masked.length > limit ? `${masked.slice(0, limit)} [cut short]` : masked;
}
