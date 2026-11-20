/**
 * Checks a tenant's details must pass before they are saved
 * (docs/decisions/admin.md ADM17, ADM19). The database checks the same
 * shapes; these answer in plain words first.
 */

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

/** An Australian Business Number as typed, without its spaces. */
export const normaliseAbn = (typed: string): string => typed.replace(/\s+/g, '');

/** The ATO's checksum: take one from the first digit, weight each digit, and the sum divides by 89. As platform.abn_valid. */
export function abnValid(abn: string): boolean {
  if (!/^\d{11}$/.test(abn)) return false;
  const sum = ABN_WEIGHTS.reduce((total, weight, i) => total + (Number(abn[i]) - (i === 0 ? 1 : 0)) * weight, 0);
  return sum % 89 === 0;
}

/** A host as people type it: lower case, with no scheme, port, path or trailing dot. Null when it isn't a host name. */
export function normaliseHost(typed: string): string | null {
  const host = typed
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  const shaped = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
  return shaped && host.length <= 253 ? host : null;
}

/** The two inks a filled button can carry on a brand's colour, as the web app's brand pages use them. */
const LIGHT_INK = '#ffffff';
const DARK_INK = '#0a0a0a';

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Whether white or near-black text reaches 4.5:1 on the colour, so buttons in it stay readable (ADM17). */
export function colourReadable(hex: string): boolean {
  return Math.max(contrastRatio(hex, LIGHT_INK), contrastRatio(hex, DARK_INK)) >= 4.5;
}
