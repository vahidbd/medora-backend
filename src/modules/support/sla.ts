import type { TicketPriority, TicketQueue } from '../../db/schema/values.js';

/**
 * First-response targets (docs/decisions/support.md SUP5). Wall-clock
 * minutes, so a weekend never pauses an urgent clinical ticket. The figures
 * are the platform's maximums: a tenant may shorten one, never lengthen it.
 */
export const RESPONSE_MINUTES = {
  urgent: 60,
  clinical: 4 * 60,
  support: 24 * 60,
} as const;

export type ResponseTarget = keyof typeof RESPONSE_MINUTES;

export function responseTarget(queue: TicketQueue, priority: TicketPriority): ResponseTarget {
  if (priority === 'urgent') return 'urgent';
  return queue === 'clinical' ? 'clinical' : 'support';
}

/** When the first reply is due for a ticket that started at `from`. */
export function firstResponseDue(from: Date, queue: TicketQueue, priority: TicketPriority): Date {
  return new Date(from.getTime() + RESPONSE_MINUTES[responseTarget(queue, priority)] * 60_000);
}

/**
 * Which replies count as the first response (SUP5): never an automatic
 * reply; in the urgent and clinical queues only a person's; in the support
 * queue an agent's too.
 */
export function countsAsFirstResponse(input: { queue: TicketQueue; priority: TicketPriority; authorType: 'person' | 'agent' | 'system'; automated: boolean }): boolean {
  if (input.authorType === 'system') return false;
  if (input.authorType === 'agent') return input.queue === 'support' && input.priority === 'normal';
  return !input.automated;
}
