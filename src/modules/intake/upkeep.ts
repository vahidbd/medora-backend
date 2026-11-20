import { and, eq, inArray, isNotNull, isNull, lt, type SQL, sql } from 'drizzle-orm';
import { intakes } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { withdrawnVersionIds } from '../protocols/index.js';

/**
 * Intakes that lapse (docs/decisions/intake.md INT4, INT7, INT14). Applied to
 * one intake whenever it is opened, so a lapse never waits for a job, and to
 * the whole tenant by the clean-up job once the job runner lands.
 *
 * - Unclaimed for 14 days since last activity: answers and date of birth
 *   cleared, the token dropped, the row kept; one still in progress ends as
 *   `unclaimed`.
 * - Claimed, in progress and idle for 30 days: ends as `expired`, answers kept.
 * - In progress on a withdrawn version: ends as `version_withdrawn`.
 */

export const UNCLAIMED_DAYS = 14;
export const IDLE_DAYS = 30;

export type IntakeFilter = { intakeId: string } | { tokenHashes: string[] } | Record<string, never>;

function scope(tx: TenantTx, filter: IntakeFilter): SQL {
  const tenant = eq(intakes.tenantId, tx.context.tenantId);
  if ('intakeId' in filter) return and(tenant, eq(intakes.id, filter.intakeId))!;
  if ('tokenHashes' in filter) return and(tenant, inArray(intakes.resumeTokenHash, filter.tokenHashes))!;
  return tenant;
}

const before = (days: number) => sql`now() - make_interval(days => ${days})`;

async function ended(tx: TenantTx, rows: { id: string; programId: string; wasInProgress: boolean }[], reason: 'unclaimed' | 'expired' | 'version_withdrawn') {
  for (const row of rows) {
    const record = { recordTable: 'clinical.intakes', recordId: row.id } as const;
    await audit(tx, { action: reason === 'unclaimed' ? 'intake.cleared' : 'intake.lapsed', zone: 'clinical', ...record, details: { reason } });
    if (row.wasInProgress) await emitEvent(tx, { type: 'intake.ended', ...record, payload: { programId: row.programId, status: 'ended', reason } });
  }
}

/** Apply every lapse due to the intakes the filter names. Returns how many changed. */
export async function settleIntakes(tx: TenantTx, filter: IntakeFilter = {}): Promise<number> {
  const where = scope(tx, filter);
  const inProgress = sql<boolean>`${intakes.status} = 'in_progress'`;
  const unclaimed = await tx.db
    .update(intakes)
    .set({
      answers: null,
      dateOfBirth: null,
      resumeTokenHash: null,
      clearedAt: sql`now()`,
      status: sql`case when ${inProgress} then 'ended' else ${intakes.status} end`,
      endedReason: sql`case when ${inProgress} then 'unclaimed' else ${intakes.endedReason} end`,
      endedAt: sql`coalesce(${intakes.endedAt}, now())`,
    })
    .where(and(where, isNull(intakes.patientId), isNull(intakes.clearedAt), lt(intakes.lastActiveAt, before(UNCLAIMED_DAYS))))
    .returning({ id: intakes.id, programId: intakes.programId, wasInProgress: sql<boolean>`${intakes.endedReason} = 'unclaimed'` });
  await ended(tx, unclaimed, 'unclaimed');

  const idle = await tx.db
    .update(intakes)
    .set({ status: 'ended', endedReason: 'expired', endedAt: sql`now()` })
    .where(and(where, isNotNull(intakes.patientId), eq(intakes.status, 'in_progress'), lt(intakes.lastActiveAt, before(IDLE_DAYS))))
    .returning({ id: intakes.id, programId: intakes.programId });
  await ended(tx, idle.map((row) => ({ ...row, wasInProgress: true })), 'expired');

  const withdrawn = await withdrawnVersionIds(tx);
  const stopped =
    withdrawn.length === 0
      ? []
      : await tx.db
          .update(intakes)
          .set({ status: 'ended', endedReason: 'version_withdrawn', endedAt: sql`now()` })
          .where(and(where, eq(intakes.status, 'in_progress'), inArray(intakes.protocolVersionId, withdrawn)))
          .returning({ id: intakes.id, programId: intakes.programId });
  await ended(tx, stopped.map((row) => ({ ...row, wasInProgress: true })), 'version_withdrawn');
  return unclaimed.length + idle.length + stopped.length;
}
