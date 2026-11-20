import { and, asc, desc, eq, exists, gte, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { consultEvidence, consults } from '../../db/schema/index.js';
import type { ConsultMode, EvidenceEvent, EvidenceParty } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { clinicianStanding } from '../clinicians/index.js';
import { type EvidenceMark, sharedTime } from './shared-time.js';

/**
 * The consult gate (ADR 0009, docs/decisions/consults.md CNS1 to CNS6): no
 * script without a recorded real-time consult. Worked out from consult
 * evidence every time; the consult's status is read only to leave out
 * cancelled and no-show consults.
 */

/** The platform's floor. A tenant may only make these stricter (CNS6). */
export const CONSULT_GATE_FLOOR = { togetherSeconds: 60, usableHours: 24 } as const;

export interface QualifyingConsult {
  consultId: string;
  mode: ConsultMode;
  /** The start of the first proven time together. */
  startedAt: Date;
  endedAt: Date | null;
  /** The disconnect that completed the proven minimum. */
  qualifiedAt: Date;
  /** 24 hours after the patient and clinician were last proven together. */
  usableUntil: Date;
}

type Consult = typeof consults.$inferSelect;
type Verdict = { consult: QualifyingConsult; reason: null } | { consult: null; reason: 'too_short' | 'window_closed' };

const NEVER_QUALIFY = ['cancelled', 'no_show'];
const HOUR_MS = 3_600_000;

async function databaseNow(tx: TenantTx): Promise<Date> {
  const result = await tx.db.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(result.rows[0]!.now);
}

/** Evidence for these consults known at `upTo` (all of it if not given): the patient's rows and the consult's own clinician's. */
export async function marksOf(tx: TenantTx, list: Consult[], upTo?: Date): Promise<Map<string, EvidenceMark[]>> {
  const marks = new Map<string, EvidenceMark[]>(list.map((consult) => [consult.id, []]));
  if (list.length === 0) return marks;
  const clinicianOf = new Map(list.map((consult) => [consult.id, consult.clinicianUserId]));
  const rows = await tx.db
    .select({
      consultId: consultEvidence.consultId,
      party: consultEvidence.party,
      clinicianUserId: consultEvidence.clinicianUserId,
      event: consultEvidence.event,
      channel: consultEvidence.channel,
      at: consultEvidence.at,
    })
    .from(consultEvidence)
    .where(and(eq(consultEvidence.tenantId, tx.context.tenantId), inArray(consultEvidence.consultId, [...marks.keys()]), upTo ? lte(consultEvidence.at, upTo) : undefined))
    .orderBy(asc(consultEvidence.at), asc(consultEvidence.id));
  for (const row of rows) {
    if (row.party === 'clinician' && row.clinicianUserId !== clinicianOf.get(row.consultId)) continue;
    marks.get(row.consultId)!.push({ party: row.party as EvidenceParty, event: row.event as EvidenceEvent, channel: row.channel as ConsultMode, at: row.at });
  }
  return marks;
}

function judge(consult: Consult, marks: EvidenceMark[], at: Date, options: { window: boolean }): Verdict {
  const shared = sharedTime(marks, CONSULT_GATE_FLOOR.togetherSeconds);
  if (!shared.qualifiedAt || !shared.lastTogetherAt || !shared.firstProvenAt) return { consult: null, reason: 'too_short' };
  const usableUntil = new Date(shared.lastTogetherAt.getTime() + CONSULT_GATE_FLOOR.usableHours * HOUR_MS);
  if (options.window && at > usableUntil) return { consult: null, reason: 'window_closed' };
  return {
    reason: null,
    consult: {
      consultId: consult.id,
      mode: consult.mode as ConsultMode,
      startedAt: shared.firstProvenAt,
      endedAt: consult.endedAt,
      qualifiedAt: shared.qualifiedAt,
      usableUntil,
    },
  };
}

/**
 * The consult that lets this clinician write this patient a script at `at`,
 * or null. `at` defaults to the database's clock; script writing must leave
 * it out, so nothing can be backdated (CNS8). The clinician must also be a
 * prescriber in good standing at `at`. Every call is audited (ADR 0008).
 */
export async function findQualifyingConsult(
  tx: TenantTx,
  input: { patientId: string; clinicianUserId: string; at?: Date },
): Promise<QualifyingConsult | null> {
  const at = input.at ?? (await databaseNow(tx));
  const found = await qualifying(tx, { ...input, at });
  await audit(tx, {
    action: 'consult.gate_checked',
    zone: 'clinical',
    recordTable: 'clinical.patients',
    recordId: input.patientId,
    details: { clinicianUserId: input.clinicianUserId, found: found.consult !== null, consultId: found.consult?.consultId ?? null, reason: found.reason },
  });
  return found.consult;
}

async function qualifying(
  tx: TenantTx,
  input: { patientId: string; clinicianUserId: string; at: Date },
): Promise<{ consult: QualifyingConsult | null; reason: string | null }> {
  const standing = await clinicianStanding(tx, input.clinicianUserId, input.at);
  if (!standing.mayPrescribe) return { consult: null, reason: 'not_a_prescriber' };
  const since = new Date(input.at.getTime() - CONSULT_GATE_FLOOR.usableHours * HOUR_MS);
  const candidates = await tx.db
    .select()
    .from(consults)
    .where(
      and(
        eq(consults.tenantId, tx.context.tenantId),
        eq(consults.patientId, input.patientId),
        eq(consults.clinicianUserId, input.clinicianUserId),
        notInArray(consults.status, NEVER_QUALIFY),
        exists(
          tx.db
            .select({ one: sql`1` })
            .from(consultEvidence)
            .where(and(eq(consultEvidence.tenantId, consults.tenantId), eq(consultEvidence.consultId, consults.id), gte(consultEvidence.at, since), lte(consultEvidence.at, input.at))),
        ),
      ),
    );
  if (candidates.length === 0) return { consult: null, reason: 'no_consult' };
  const marks = await marksOf(tx, candidates, input.at);
  const verdicts = candidates.map((consult) => judge(consult, marks.get(consult.id)!, input.at, { window: true }));
  const best = verdicts
    .flatMap((verdict) => (verdict.consult ? [verdict.consult] : []))
    .sort((a, b) => b.usableUntil.getTime() - a.usableUntil.getTime())[0];
  if (best) return { consult: best, reason: null };
  return { consult: null, reason: verdicts.some((verdict) => verdict.reason === 'window_closed') ? 'window_closed' : 'too_short' };
}

/**
 * Every consult with enough proven time together for this patient (and
 * clinician, if given), newest first, whatever the window: for a reviewer
 * linking a script by hand. Standing is the caller's to check. Audited.
 */
export async function listQualifyingConsults(tx: TenantTx, input: { patientId: string; clinicianUserId?: string }): Promise<QualifyingConsult[]> {
  const at = await databaseNow(tx);
  const list = await tx.db
    .select()
    .from(consults)
    .where(
      and(
        eq(consults.tenantId, tx.context.tenantId),
        eq(consults.patientId, input.patientId),
        input.clinicianUserId ? eq(consults.clinicianUserId, input.clinicianUserId) : undefined,
        notInArray(consults.status, NEVER_QUALIFY),
      ),
    )
    .orderBy(desc(consults.createdAt));
  const marks = await marksOf(tx, list, at);
  const found = list
    .flatMap((consult) => judge(consult, marks.get(consult.id)!, at, { window: false }).consult ?? [])
    .sort((a, b) => b.qualifiedAt.getTime() - a.qualifiedAt.getTime());
  await audit(tx, {
    action: 'consult.qualifying_listed',
    zone: 'clinical',
    recordTable: 'clinical.patients',
    recordId: input.patientId,
    details: { clinicianUserId: input.clinicianUserId ?? null, count: found.length },
  });
  return found;
}
