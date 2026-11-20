/**
 * What help centre wording may hold (docs/decisions/support.md SUP16, SUP18).
 * Pure functions, so the screen's form and the API refuse the same things.
 */

/** The checks an approved version passed, stored on it. Bump when a rule is added. */
export const PUBLISH_CHECKS = 'format-1';

/** What the approver confirms, stored word for word on the version they approve (SUP18). */
export const SERVICE_ONLY_CONFIRMATION = 'This article describes our service only. It gives no medical advice and names no medicine.';

const HTML = /<[a-z!/?]/i;
const IMAGE = /!\[/;
const INLINE_LINK = /\]\(\s*<?([^)\s>]*)/g;
const REFERENCE_LINK = /^\s*\[[^\]]+\]:\s*<?(\S*?)>?(\s|$)/gm;

/** A link goes to a secure page or to one of the brand's own pages. */
function allowedLink(target: string): boolean {
  return /^https:\/\/[^\s/]/i.test(target) || /^\/(?!\/)/.test(target) || target.startsWith('#');
}

/**
 * Problems with an article's Markdown, in words for the person writing it.
 * No raw HTML and no images (they would need a new origin in the web app's
 * content security policy); links only to https pages or the brand's own.
 */
export function wordingProblems(text: string): string[] {
  const problems: string[] = [];
  if (HTML.test(text)) problems.push('Remove the HTML: write headings, lists and links in Markdown');
  if (IMAGE.test(text)) problems.push('Remove the image: the help centre shows text only');
  const targets = [...text.matchAll(INLINE_LINK), ...text.matchAll(REFERENCE_LINK)].map((match) => match[1] ?? '');
  if (targets.some((target) => !allowedLink(target))) problems.push('Links must start with https:// or point to one of your own pages, like /help');
  return problems;
}

/** The wording a version would publish. */
export interface Wording {
  title: string;
  summary: string;
  body: string;
}

/**
 * Every check a version must pass to go public, run when it is approved and
 * again when it is put back up (SUP16). The prescription-only names in the
 * tenant's catalogue join here when the products module exists; until then
 * no brand's help centre goes live (docs/launch-checklist.md).
 */
export function publishProblems(wording: Wording): string[] {
  return [...new Set([wording.title, wording.summary, wording.body].flatMap(wordingProblems))];
}
