import { z } from 'zod';
import { CANCEL_REASONS, type CancelReason, HELD_REASONS, INTERVAL_UNITS, SUBSCRIPTION_STATUSES } from '../../db/schema/values.js';

/** A calendar date in the subscription's time zone. */
const calendarDate = z.iso.date();

/** The reasons staff give. `clinician_declined` is recorded only when the clinical record says so, and `payment_failed` only by the retries (BIL21, BIL24, BIL31). */
export const STAFF_CANCEL_REASONS = ['patient_request', 'staff_decision', 'other'] as const satisfies readonly CancelReason[];

export const subscriptionParams = z.object({ subscriptionId: z.uuid() });
export const subscriptionsQuery = z.object({ patientId: z.uuid().optional(), status: z.enum(SUBSCRIPTION_STATUSES).optional() });

export const pauseBody = z.object({ resumesOn: calendarDate });
export const cancelBody = z.object({ when: z.enum(['period_end', 'now']), reason: z.enum(STAFF_CANCEL_REASONS) });

export const subscription = z.object({
  subscriptionId: z.uuid(),
  patientId: z.uuid(),
  programId: z.uuid(),
  priceId: z.uuid(),
  paymentAccountId: z.uuid(),
  timeZone: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  interval: z.object({ unit: z.enum(INTERVAL_UNITS), count: z.number().int() }),
  /** The paid period, once the first one is released. */
  currentPeriod: z.object({ startsOn: calendarDate, endsOn: calendarDate }).nullable(),
  /** When the next billing period starts: later than the current period's end after a pause or skip. */
  nextPeriodStartsOn: calendarDate.nullable(),
  /** Due to end when the current period does, unless reinstated first. */
  cancelsAtPeriodEnd: z.boolean(),
  cancelReason: z.enum(CANCEL_REASONS).nullable(),
  endedOn: calendarDate.nullable(),
  /** A due period with no invoice yet, and why, as the renewal job last heard. */
  renewalHeld: z.object({ reason: z.enum(HELD_REASONS), checkedAt: z.iso.datetime() }).nullable(),
  createdAt: z.iso.datetime(),
});

export const subscriptionsReply = z.object({ subscriptions: z.array(subscription) });
