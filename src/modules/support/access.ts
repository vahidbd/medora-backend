import type { TicketFlag, TicketQueue } from '../../db/schema/values.js';
import type { Actor } from '../../db/tenant.js';
import { ForbiddenError } from '../../lib/errors.js';
import type { Permission } from '../../lib/permissions.js';

/**
 * Who may see and do what on a ticket (docs/decisions/support.md). The API
 * hides; the screen only reflects it (SUP2).
 */
export interface Viewer {
  actor: Actor;
  permissions: ReadonlySet<Permission>;
  /** The staff member's membership in the tenant; null for an agent. */
  membershipId: string | null;
}

/** A ticket in the clinical queue shows its text only to support:clinical (SUP2). */
export function canReadText(viewer: Viewer, queue: TicketQueue): boolean {
  return queue === 'clinical' ? viewer.permissions.has('support:clinical') : viewer.permissions.has('support:read');
}

export function assertCanReadText(viewer: Viewer, queue: TicketQueue): void {
  if (!canReadText(viewer, queue)) throw new ForbiddenError('This ticket is in the clinical queue. A clinician will pick it up.', 'clinical_queue');
}

/** Flags that stop an agent replying: only people answer these (SUP12). */
export const STAFF_ONLY_FLAGS: ReadonlySet<TicketFlag> = new Set(['emergency', 'self_harm', 'possible_adverse_event', 'possible_complaint', 'legal', 'person_requested']);

/** Whether this actor may send a reply on the ticket. */
export function replyRefusal(viewer: Viewer, ticket: { queue: TicketQueue; flags: readonly TicketFlag[] }): string | null {
  if (!viewer.permissions.has('support:reply')) return "You don't have permission to reply";
  if (!canReadText(viewer, ticket.queue)) return 'This ticket is in the clinical queue';
  if (viewer.actor.type === 'agent') {
    if (ticket.queue === 'clinical') return 'Agents never reply in the clinical queue';
    if (ticket.flags.some((flag) => STAFF_ONLY_FLAGS.has(flag))) return 'This ticket is for staff to answer';
  }
  return null;
}

export function assertCanReply(viewer: Viewer, ticket: { queue: TicketQueue; flags: readonly TicketFlag[] }): void {
  const refusal = replyRefusal(viewer, ticket);
  if (refusal) throw new ForbiddenError(refusal, 'reply_refused');
}
