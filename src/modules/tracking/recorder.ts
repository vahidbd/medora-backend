import type { RecordedByType } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { ForbiddenError } from '../../lib/errors.js';

/**
 * Who writes a measurement or reports a side effect: the patient on their
 * own record, or a staff member for them (TRK3). An agent or the system
 * never does; their reports reach the care team as messages instead.
 */
export function recorderOf(tx: TenantTx): { type: RecordedByType; id: string } {
  const { actor } = tx.context;
  if (actor.type === 'patient') return { type: 'patient', id: actor.patientId };
  if (actor.type === 'person') return { type: 'person', id: actor.userId };
  throw new ForbiddenError('Only a patient or their care team records this');
}

/** How a recorder reads to the patient: themselves, or their care team (never a staff member's name). */
export function recordedByOf(type: string): 'patient' | 'care_team' {
  return type === 'patient' ? 'patient' : 'care_team';
}
