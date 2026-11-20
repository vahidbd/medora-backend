import { and, eq } from 'drizzle-orm';
import { consultEvidence, consults } from '../../db/schema/index.js';
import type { ConsultMode, EvidenceEvent, EvidenceParty } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import type { WebhookDelivery } from '../../lib/webhooks.js';
import { CONSULT_GATE_FLOOR, marksOf } from './gate.service.js';
import { sharedTime } from './shared-time.js';
import type { Participant } from './video-room.js';

/**
 * Consult evidence, written only by the handlers of verified provider
 * callbacks (docs/decisions/consults.md CNS2). Nothing else in Medora calls
 * these: no route, agent tool or test helper. Each write is audited, and the
 * consult's status follows the evidence in the same transaction (CNS3).
 */

const RECORD = 'clinical.consults' as const;

/** A provider time further ahead of our receipt than this is not believed (CNS5). */
const CLOCK_TOLERANCE_MS = 30_000;

type Consult = typeof consults.$inferSelect;

async function consultFor(tx: TenantTx, consultId: string): Promise<Consult | null> {
  const [row] = await tx.db
    .select()
    .from(consults)
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consultId)))
    .for('update');
  return row ?? null;
}

function believable(at: Date, delivery: WebhookDelivery): boolean {
  return Number.isFinite(at.getTime()) && at.getTime() <= delivery.receivedAt.getTime() + CLOCK_TOLERANCE_MS;
}

async function record(
  tx: TenantTx,
  delivery: WebhookDelivery,
  consult: Consult,
  input: { channel: ConsultMode; at: Date; event: EvidenceEvent; parties: EvidenceParty[] },
): Promise<void> {
  const rows = input.parties.map((party) => ({
    tenantId: tx.context.tenantId,
    consultId: consult.id,
    party,
    clinicianUserId: party === 'clinician' ? consult.clinicianUserId : null,
    event: input.event,
    channel: input.channel,
    at: input.at,
    deliveryId: delivery.deliveryId,
  }));
  const inserted = await tx.db.insert(consultEvidence).values(rows).onConflictDoNothing().returning({ id: consultEvidence.id });
  if (inserted.length === 0) return;
  await audit(tx, {
    action: 'consult_evidence.recorded',
    zone: 'clinical',
    recordTable: RECORD,
    recordId: consult.id,
    details: { deliveryId: delivery.deliveryId, channel: input.channel, event: input.event, parties: input.parties.join(',') },
  });
}

function eventFacts(consult: Consult) {
  return { patientId: consult.patientId, consultId: consult.id, clinicianUserId: consult.clinicianUserId, mode: consult.mode };
}

/** A scheduled consult starts at the first moment the patient and its clinician were connected together. */
async function settleStart(tx: TenantTx, consult: Consult): Promise<Consult> {
  if (consult.status !== 'scheduled') return consult;
  const marks = await marksOf(tx, [consult]);
  const { firstTogetherAt } = sharedTime(marks.get(consult.id)!, CONSULT_GATE_FLOOR.togetherSeconds);
  if (!firstTogetherAt) return consult;
  const [started] = await tx.db
    .update(consults)
    .set({ status: 'in_progress', startedAt: firstTogetherAt, updatedAt: new Date() })
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consult.id)))
    .returning();
  await audit(tx, { action: 'consult.started', zone: 'clinical', recordTable: RECORD, recordId: consult.id, details: { startedAt: firstTogetherAt.toISOString() } });
  await emitEvent(tx, { type: 'consult.started', recordTable: RECORD, recordId: consult.id, payload: eventFacts(consult) });
  return started!;
}

/** The patient or the consult's clinician connected or left. Anyone else in the room is not evidence (CNS7). */
export async function recordConnection(
  tx: TenantTx,
  delivery: WebhookDelivery,
  input: { consultId: string; channel: ConsultMode; at: Date; event: EvidenceEvent; participant: Participant },
): Promise<void> {
  if (!believable(input.at, delivery)) return;
  const consult = await consultFor(tx, input.consultId);
  if (!consult) return;
  const { participant } = input;
  const theirs = participant.party === 'patient' ? participant.patientId === consult.patientId : participant.userId === consult.clinicianUserId;
  if (!theirs) return;
  await record(tx, delivery, consult, { channel: input.channel, at: input.at, event: input.event, parties: [participant.party] });
  await settleStart(tx, consult);
}

/**
 * The room or call is over, so nobody is connected in that channel any more.
 * An in-progress consult is completed; one that never started stays as it is
 * for booking to mark (CNS3).
 */
export async function recordFinish(tx: TenantTx, delivery: WebhookDelivery, input: { consultId: string; channel: ConsultMode; at: Date }): Promise<void> {
  if (!believable(input.at, delivery)) return;
  const found = await consultFor(tx, input.consultId);
  if (!found) return;
  await record(tx, delivery, found, { channel: input.channel, at: input.at, event: 'disconnected', parties: ['patient', 'clinician'] });
  const consult = await settleStart(tx, found);
  if (consult.status !== 'in_progress' || !consult.startedAt) return;
  const endedAt = input.at < consult.startedAt ? consult.startedAt : input.at;
  await tx.db
    .update(consults)
    .set({ status: 'completed', endedAt, updatedAt: new Date() })
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consult.id)));
  await audit(tx, { action: 'consult.completed', zone: 'clinical', recordTable: RECORD, recordId: consult.id, details: { endedAt: endedAt.toISOString() } });
  await emitEvent(tx, { type: 'consult.completed', recordTable: RECORD, recordId: consult.id, payload: eventFacts(consult) });
}
