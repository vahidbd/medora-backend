import { eq } from 'drizzle-orm';
import { parchmentPatients, parchmentPrescribers, prescribingSessions } from '../../db/schema/index.js';
import { type TenantContext, type TenantTx, withTenant } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { AppError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { requireParchment } from './parchment/connection.js';
import { toParchmentPatient } from './parchment/patient.js';
import { ParchmentFailure, type ParchmentClient } from './parchment/types.js';
import { prescribingDependencies } from './ports.js';

/**
 * Opening Parchment for a patient: the consult gate (ADR 0009, RX1).
 *
 * 1. In one transaction: the person is a prescriber in good standing, a
 *    qualifying consult with this patient exists, and the patient's record
 *    has what Parchment needs.
 * 2. After that commits: create or update the patient in Parchment, and find
 *    the prescriber's Parchment account the first time (RX3). These calls
 *    happen in the request because the prescriber is waiting for the page;
 *    the patient call is keyed by our patient id (RX2, ADR 0029).
 * 3. In a second transaction: check the consult again, then record the
 *    prescribing session, which scripts written in Parchment will link to.
 *
 * Parchment unreachable means no session and no page: the gate fails closed.
 */
export interface OpenedSession {
  sessionId: string;
  consultId: string;
  parchmentUrl: string;
}

function personOf(context: TenantContext): string {
  if (context.actor.type !== 'person') throw new ForbiddenError('Only a person can open Parchment', 'person_only');
  return context.actor.userId;
}

async function passGate(tx: TenantTx, patientId: string, prescriberUserId: string) {
  const deps = prescribingDependencies();
  const standing = await deps.clinicianStanding(tx, prescriberUserId);
  if (!standing.mayPrescribe) {
    throw new AppError(403, 'not_a_prescriber', 'Only a prescriber with a current registration and indemnity can open Parchment', { reasons: standing.reasons });
  }
  const consult = await deps.findQualifyingConsult(tx, { patientId, clinicianUserId: prescriberUserId });
  if (!consult) {
    throw new BusinessRuleError('Parchment opens only after you have spoken with this patient in a phone or video consult', 'consult_required');
  }
  return consult;
}

const FIELD_WORDS: Record<string, string> = {
  given_name: 'given name',
  family_name: 'family name',
  date_of_birth: 'date of birth',
  mobile_phone: 'mobile number',
  email: 'email',
  australian_street_address: 'home address',
  medicare_card_number: 'Medicare number',
  medicare_irn: 'Medicare reference number',
};

function parchmentError(error: unknown): never {
  if (error instanceof ParchmentFailure && error.status === 400 && error.fields.length > 0) {
    const words = [...new Set(error.fields.map((field) => FIELD_WORDS[field.split('.')[0] ?? ''] ?? 'details'))];
    throw new BusinessRuleError(`Parchment didn't accept the patient's ${words.join(', ')}. Check the record and try again.`, 'parchment_refused_patient');
  }
  if (error instanceof AppError) throw error;
  throw new AppError(502, 'parchment_unavailable', "Parchment didn't answer. Try again in a minute.");
}

async function findParchmentAccount(client: ParchmentClient, email: string): Promise<string> {
  const users = await client.listUsers();
  const matches = users.filter((user) => user.email === email.toLowerCase());
  if (matches.length !== 1) {
    throw new BusinessRuleError(
      "We couldn't find your Parchment account. Ask an owner to add you to this clinic's Parchment with the email you sign in to Medora with.",
      'parchment_account_missing',
    );
  }
  return matches[0]!.parchmentUserId;
}

export async function openParchment(context: TenantContext, patientId: string, prescriberEmail: string): Promise<OpenedSession> {
  const prescriberUserId = personOf(context);
  const connection = requireParchment(context.tenantId);

  const prepared = await withTenant(context, async (tx) => {
    await passGate(tx, patientId, prescriberUserId);
    const patient = await prescribingDependencies().getPatientForPrescribing(tx, patientId);
    if (!patient) throw new NotFoundError('Patient');
    const mapped = toParchmentPatient(patient);
    if ('missing' in mapped) {
      throw new BusinessRuleError(`Add the patient's ${mapped.missing.join(', ')} before opening Parchment`, 'patient_details_missing');
    }
    const [link] = await tx.db.select().from(parchmentPatients).where(eq(parchmentPatients.patientId, patientId));
    const [account] = await tx.db.select().from(parchmentPrescribers).where(eq(parchmentPrescribers.userId, prescriberUserId));
    return { details: mapped.details, link, account };
  });

  let parchmentPatientId = prepared.link?.parchmentPatientId;
  let parchmentUserId = prepared.account?.parchmentUserId;
  try {
    parchmentUserId ??= await findParchmentAccount(connection.client, prescriberEmail);
    if (parchmentPatientId) await connection.client.updatePatient(parchmentPatientId, prepared.details);
    else parchmentPatientId = (await connection.client.createPatient(prepared.details)).parchmentPatientId;
  } catch (error) {
    parchmentError(error);
  }

  return withTenant(context, async (tx) => {
    const consult = await passGate(tx, patientId, prescriberUserId);
    if (!prepared.account) {
      await tx.db.insert(parchmentPrescribers).values({ tenantId: context.tenantId, userId: prescriberUserId, parchmentUserId }).onConflictDoNothing();
      await audit(tx, { action: 'parchment_prescriber.linked', zone: 'operational', recordTable: 'operational.parchment_prescribers', recordId: prescriberUserId });
    }
    const [account] = await tx.db.select().from(parchmentPrescribers).where(eq(parchmentPrescribers.userId, prescriberUserId));
    const linkedPatientId = await recordPatientLink(tx, patientId, parchmentPatientId, !prepared.link);
    const [session] = await tx.db
      .insert(prescribingSessions)
      .values({ tenantId: context.tenantId, patientId, prescriberUserId, parchmentUserId: account!.parchmentUserId, consultId: consult.consultId })
      .returning({ id: prescribingSessions.id });
    const sessionId = session!.id;
    await audit(tx, { action: 'prescribing_session.opened', zone: 'clinical', recordTable: 'clinical.prescribing_sessions', recordId: sessionId, details: { consultId: consult.consultId } });
    await emitEvent(tx, { type: 'prescribing_session.opened', recordTable: 'clinical.prescribing_sessions', recordId: sessionId, payload: { patientId, consultId: consult.consultId } });
    return { sessionId, consultId: consult.consultId, parchmentUrl: connection.portalUrl(linkedPatientId) };
  });
}

/**
 * Record that the patient's details went to Parchment. Two first opens at
 * once can each create a Parchment patient; the first link stands and is
 * the one every later open and webhook uses.
 */
async function recordPatientLink(tx: TenantTx, patientId: string, parchmentPatientId: string, created: boolean): Promise<string> {
  if (created) {
    await tx.db.insert(parchmentPatients).values({ tenantId: tx.context.tenantId, patientId, parchmentPatientId }).onConflictDoNothing();
  } else {
    await tx.db.update(parchmentPatients).set({ syncedAt: new Date() }).where(eq(parchmentPatients.patientId, patientId));
  }
  const [link] = await tx.db.select().from(parchmentPatients).where(eq(parchmentPatients.patientId, patientId));
  await audit(tx, { action: 'parchment_patient.sent', zone: 'clinical', recordTable: 'clinical.parchment_patients', recordId: link!.id, details: { created } });
  return link!.parchmentPatientId;
}
