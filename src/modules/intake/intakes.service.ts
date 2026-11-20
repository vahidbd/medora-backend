import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { intakes, tenants } from '../../db/schema/index.js';
import type { IntakeEndReason, IntakeStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { AppError, BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { decryptOptional, encryptField } from '../../lib/field-crypto.js';
import { localDate } from '../../lib/time.js';
import { assertAcceptingPatients } from '../brands/index.js';
import { ageOn, assertConsents, currentConsentDocument, DATE_OF_BIRTH_MESSAGES, dateOfBirthProblem, findPatient, givenConsentOf, recordIntakeConsent } from '../patients/index.js';
import { type Answers, type Definition, firstHardStop, firstUnfinishedStep, getProgram, liveVersionOf, protocolVersionById, readStepAnswers, redFlagsOf, shownFlow } from '../protocols/index.js';
import { settleIntakes } from './upkeep.js';

/**
 * Intakes (PRD INT-02, INT-03, INT-05; docs/decisions/intake.md INT5 to
 * INT8, INT12 to INT15). A person answers one program's questions, step by
 * step, on the protocol version live when they started. The rules run here
 * after every step. Answers are sealed (ADR 0010) and never leave the
 * clinical zone: events carry the program and status only.
 */

export const INTAKES = 'clinical.intakes' as const;
export const ANSWERS_PURPOSE = 'clinical.intakes.answers' as const;

/** Who is answering: a browser holding the intake's resume token, or the signed-in patient it belongs to. */
export type Holder = { token: string } | { patientId: string };

export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

type IntakeRow = typeof intakes.$inferSelect;
type PinnedVersion = Awaited<ReturnType<typeof protocolVersionById>>;

export interface IntakeQuestion {
  key: string;
  label: string;
  help?: string;
  kind: string;
  required: boolean;
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
}

export interface IntakeView {
  intakeId: string;
  programId: string;
  programName: string;
  status: IntakeStatus;
  endedReason: IntakeEndReason | null;
  /** The steps shown with the answers so far; a step's questions are only those its show-ifs allow. */
  steps: { key: string; title: string; intro?: string; done: boolean; questions: IntakeQuestion[] }[];
  /** The step to answer next, or null when every shown step is done. */
  currentStep: string | null;
  answers: Answers;
  /** Why the intake ended, in the protocol's words for the patient, when a hard stop ended it. */
  stop: { message: string; urgentHelp: boolean } | null;
  readyToSubmit: boolean;
  startedAt: string;
  submittedAt: string | null;
}

const asQuestion = ({ showIf: _showIf, ...question }: Definition['steps'][number]['questions'][number]): IntakeQuestion => question;

export async function tenantTimeZone(tx: TenantTx): Promise<string> {
  const [row] = await tx.db.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tx.context.tenantId));
  return row?.timeZone ?? 'Australia/Sydney';
}

async function tenantToday(tx: TenantTx): Promise<{ timeZone: string; today: string }> {
  const timeZone = await tenantTimeZone(tx);
  return { timeZone, today: localDate(new Date(), timeZone) };
}

/** Age on the tenant's calendar date (INT13), as the date-of-birth check works it out. */
async function ageOf(tx: TenantTx, row: IntakeRow): Promise<number | null> {
  return row.dateOfBirth ? ageOn(row.dateOfBirth, (await tenantToday(tx)).today) : null;
}

export async function answersOf(tx: TenantTx, row: IntakeRow): Promise<Answers> {
  const opened = await decryptOptional(tx, ANSWERS_PURPOSE, row.answers);
  return opened ? (JSON.parse(opened) as Answers) : {};
}

/** The intake, if this holder holds it, after any lapse is applied (INT7, INT14). Not found otherwise, so a wrong token learns nothing. */
export async function loadIntake(tx: TenantTx, intakeId: string, holder: Holder): Promise<IntakeRow> {
  await settleIntakes(tx, { intakeId });
  const held = 'token' in holder ? eq(intakes.resumeTokenHash, hashToken(holder.token)) : eq(intakes.patientId, holder.patientId);
  const [row] = await tx.db
    .select()
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.id, intakeId), held))
    .for('update');
  if (!row) throw new NotFoundError('Intake');
  return row;
}

/** The first shown step not yet behind the person. */
function currentStepOf(flow: ReturnType<typeof shownFlow>, stepsDone: number) {
  return flow.steps.find((shown) => shown.index >= stepsDone) ?? null;
}

export async function viewOf(tx: TenantTx, row: IntakeRow, version?: PinnedVersion): Promise<IntakeView> {
  const pinned = version ?? (await protocolVersionById(tx, row.protocolVersionId));
  const program = await getProgram(tx, row.programId);
  const age = await ageOf(tx, row);
  const flow = shownFlow(pinned.definition, await answersOf(tx, row), age);
  const current = row.status === 'in_progress' ? currentStepOf(flow, row.stepsDone) : null;
  const rule = row.stoppedRule ? pinned.definition.rules.find((r) => r.key === row.stoppedRule) : undefined;
  return {
    intakeId: row.id,
    programId: row.programId,
    programName: program.name,
    status: row.status as IntakeStatus,
    endedReason: (row.endedReason as IntakeEndReason | null) ?? null,
    steps: flow.steps.map((shown) => ({
      key: shown.step.key,
      title: shown.step.title,
      ...(shown.step.intro ? { intro: shown.step.intro } : {}),
      done: shown.index < row.stepsDone,
      questions: shown.questions.map(asQuestion),
    })),
    currentStep: current?.step.key ?? null,
    answers: flow.answers,
    stop: rule ? { message: rule.patientMessage ?? '', urgentHelp: rule.urgentHelp } : null,
    readyToSubmit: row.status === 'in_progress' && !current && !firstUnfinishedStep(pinned.definition, flow.answers, age),
    startedAt: row.startedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
  };
}

/** A person reading their own intake: a read of clinical data, audited (ADR 0008). */
export async function readIntake(tx: TenantTx, intakeId: string, holder: Holder): Promise<IntakeView> {
  const row = await loadIntake(tx, intakeId, holder);
  await audit(tx, { action: 'intake.read', zone: 'clinical', recordTable: INTAKES, recordId: row.id, details: { holder: 'token' in holder ? 'resume_token' : 'patient' } });
  return viewOf(tx, row);
}

/** A live program on a protocol with a live version, or 409: only then can an intake start (INT9). */
async function openProgram(tx: TenantTx, programId: string) {
  const program = await getProgram(tx, programId);
  const version = program.status === 'live' ? await liveVersionOf(tx, program.protocolId) : null;
  if (!version) throw new BusinessRuleError("This program isn't taking new patients right now", 'program_unavailable');
  return { program, version };
}

/** What the first screen shows before anything is collected (INT5): the program and the privacy notice to agree to. */
export async function startScreen(tx: TenantTx, programId: string) {
  const { program } = await openProgram(tx, programId);
  await assertAcceptingPatients(tx, program.brandId);
  const privacy = await currentConsentDocument(tx, 'privacy');
  if (!privacy) throw new BusinessRuleError("This service isn't taking new patients yet", 'privacy_notice_missing');
  return { programId: program.programId, programName: program.name, privacyNotice: { documentId: privacy.documentId, version: privacy.version, title: privacy.title, body: privacy.body } };
}

async function started(tx: TenantTx, row: { id: string; programId: string; status: string; versionId: string; holder: 'resume_token' | 'patient' }) {
  const record = { recordTable: INTAKES, recordId: row.id } as const;
  await audit(tx, { action: 'intake.started', zone: 'clinical', ...record, details: { programId: row.programId, protocolVersionId: row.versionId, holder: row.holder } });
  await emitEvent(tx, { type: 'intake.started', ...record, payload: { programId: row.programId } });
  if (row.status === 'ended') await emitEvent(tx, { type: 'intake.ended', ...record, payload: { programId: row.programId, status: 'ended', reason: 'under_age' } });
}

export interface AnonymousStart {
  programId: string;
  privacyDocumentId: string;
  dateOfBirth: string;
}

/**
 * Start an intake before an account (INT5). The person has agreed to the
 * current privacy notice and confirmed they are an adult; their date of
 * birth comes first, and under 18 ends the intake before any health answer.
 * The token is returned once and only its hash is kept.
 */
export async function startAnonymous(tx: TenantTx, input: AnonymousStart): Promise<{ resumeToken: string; intake: IntakeView }> {
  const { program, version } = await openProgram(tx, input.programId);
  await assertAcceptingPatients(tx, program.brandId);
  const privacy = await currentConsentDocument(tx, 'privacy');
  if (!privacy) throw new BusinessRuleError("This service isn't taking new patients yet", 'privacy_notice_missing');
  if (privacy.documentId !== input.privacyDocumentId) throw new BusinessRuleError('The privacy notice has changed. Read the new one and agree to it.', 'not_current_version');
  const problem = dateOfBirthProblem(input.dateOfBirth, new Date(), (await tenantToday(tx)).timeZone);
  if (problem && problem !== 'under_age') throw new BadRequestError(DATE_OF_BIRTH_MESSAGES[problem], 'date_of_birth');
  const underAge = problem === 'under_age';
  const resumeToken = randomBytes(32).toString('base64url');
  const now = new Date();
  const [row] = await tx.db
    .insert(intakes)
    .values({
      tenantId: tx.context.tenantId,
      programId: program.programId,
      protocolVersionId: version.versionId,
      resumeTokenHash: hashToken(resumeToken),
      status: underAge ? 'ended' : 'in_progress',
      endedReason: underAge ? 'under_age' : null,
      endedAt: underAge ? now : null,
      // An under-18's date of birth isn't kept: the intake ends before anything is collected.
      dateOfBirth: underAge ? null : input.dateOfBirth,
      privacyDocumentId: privacy.documentId,
      privacyAgreedAt: now,
    })
    .returning();
  await started(tx, { id: row!.id, programId: program.programId, status: row!.status, versionId: version.versionId, holder: 'resume_token' });
  return { resumeToken, intake: await viewOf(tx, row!) };
}

/** A signed-in patient starts an intake; one in progress for the same program is picked up instead (INT12). */
export async function startForPatient(tx: TenantTx, patientId: string, programId: string): Promise<IntakeView> {
  const { program, version } = await openProgram(tx, programId);
  await assertConsents(tx, patientId, 'care');
  const [open] = await tx.db
    .select({ id: intakes.id })
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.patientId, patientId), eq(intakes.programId, programId), eq(intakes.status, 'in_progress')))
    .orderBy(desc(intakes.startedAt))
    .limit(1);
  if (open) {
    const row = await loadIntake(tx, open.id, { patientId });
    if (row.status === 'in_progress') return viewOf(tx, row);
  }
  const patient = await findPatient(tx, patientId);
  const privacy = await givenConsentOf(tx, patientId, 'privacy');
  if (!patient || !privacy) throw new NotFoundError('Patient');
  const [row] = await tx.db
    .insert(intakes)
    .values({
      tenantId: tx.context.tenantId,
      programId: program.programId,
      protocolVersionId: version.versionId,
      patientId,
      dateOfBirth: patient.dateOfBirth,
      privacyDocumentId: privacy.documentId,
      privacyAgreedAt: privacy.at,
    })
    .returning();
  await started(tx, { id: row!.id, programId: program.programId, status: row!.status, versionId: version.versionId, holder: 'patient' });
  return viewOf(tx, row!);
}

function assertInProgress(row: IntakeRow): void {
  if (row.status !== 'in_progress') throw new BusinessRuleError('This intake is finished. Start a new one to answer again.', 'intake_closed');
}

async function becomeIneligible(tx: TenantTx, row: IntakeRow, ruleKey: string, now: Date): Promise<void> {
  await tx.db.update(intakes).set({ status: 'ineligible', stoppedRule: ruleKey, endedAt: now }).where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.id, row.id)));
  const record = { recordTable: INTAKES, recordId: row.id } as const;
  // Which rule stopped it is clinical: it stays on the row, never in the audit details or the event (INT8).
  await audit(tx, { action: 'intake.ineligible', zone: 'clinical', ...record });
  await emitEvent(tx, { type: 'intake.ended', ...record, payload: { programId: row.programId, status: 'ineligible' } });
}

/**
 * Save one step's answers (INT12). The person may answer the current step or
 * go back to one already done. Answers no longer shown are dropped, and a
 * hard stop whose questions are all behind the person ends the intake.
 */
export async function saveStep(tx: TenantTx, intakeId: string, holder: Holder, stepKey: string, submitted: Record<string, unknown>): Promise<IntakeView> {
  const row = await loadIntake(tx, intakeId, holder);
  assertInProgress(row);
  const version = await protocolVersionById(tx, row.protocolVersionId);
  const { definition } = version;
  const age = await ageOf(tx, row);
  const flow = shownFlow(definition, await answersOf(tx, row), age);
  const shown = flow.steps.find((s) => s.step.key === stepKey);
  if (!shown) throw new NotFoundError('Step');
  if (shown.index >= row.stepsDone && shown !== currentStepOf(flow, row.stepsDone)) throw new BusinessRuleError('Answer the steps before this one first', 'step_not_reached');
  const read = readStepAnswers(shown.questions, submitted);
  if (read.problems.length > 0) throw new AppError(400, 'answer_problems', 'Check your answers', { problems: read.problems });

  const merged: Answers = { ...flow.answers };
  for (const question of shown.step.questions) delete merged[question.key];
  const answers = shownFlow(definition, { ...merged, ...read.answers }, age).answers;
  // Going back can show a step that now needs answers: progress returns to it (INT12).
  const unfinished = firstUnfinishedStep(definition, answers, age);
  const unfinishedAt = unfinished ? definition.steps.indexOf(unfinished) : definition.steps.length;
  const stepsDone = Math.min(Math.max(row.stepsDone, shown.index + 1), unfinishedAt);
  const now = new Date();
  const sealed = await encryptField(tx, ANSWERS_PURPOSE, JSON.stringify(answers));
  await tx.db.update(intakes).set({ answers: sealed, stepsDone, lastActiveAt: now }).where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.id, row.id)));
  await audit(tx, { action: 'intake.answered', zone: 'clinical', recordTable: INTAKES, recordId: row.id, details: { step: stepKey, stepsDone } });
  const stop = firstHardStop(definition, answers, age, stepsDone);
  if (stop) await becomeIneligible(tx, row, stop.key, now);
  return viewOf(tx, await loadIntake(tx, intakeId, holder), version);
}

/**
 * Send a finished intake to the prescriber (INT12). Only the patient it
 * belongs to submits, so a prescriber always has a patient record to see.
 * Every hard stop is checked once more, and the red flags are recorded.
 */
export async function submitIntake(tx: TenantTx, intakeId: string, patientId: string): Promise<IntakeView> {
  const row = await loadIntake(tx, intakeId, { patientId });
  assertInProgress(row);
  await assertConsents(tx, patientId, 'care');
  const version = await protocolVersionById(tx, row.protocolVersionId);
  const { definition } = version;
  const age = await ageOf(tx, row);
  const answers = shownFlow(definition, await answersOf(tx, row), age).answers;
  const unfinished = firstUnfinishedStep(definition, answers, age);
  const current = currentStepOf(shownFlow(definition, answers, age), row.stepsDone);
  if (unfinished || current) {
    throw new AppError(409, 'intake_unfinished', 'Answer every step before you send it', { step: (unfinished ?? current!.step).key });
  }
  const now = new Date();
  const stop = firstHardStop(definition, answers, age, definition.steps.length);
  if (stop) {
    await becomeIneligible(tx, row, stop.key, now);
  } else {
    const redFlags = redFlagsOf(definition, answers, age).map((rule) => rule.key);
    await tx.db
      .update(intakes)
      .set({ status: 'completed', submittedAt: now, redFlags, stepsDone: definition.steps.length, lastActiveAt: now })
      .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.id, row.id)));
    const record = { recordTable: INTAKES, recordId: row.id } as const;
    await audit(tx, { action: 'intake.submitted', zone: 'clinical', ...record });
    await emitEvent(tx, { type: 'intake.completed', ...record, payload: { programId: row.programId, patientId } });
  }
  return viewOf(tx, await loadIntake(tx, intakeId, { patientId }), version);
}

/**
 * Make every intake this browser started the patient's (INT6), including
 * ineligible ones, and record the privacy consent each was started under.
 * The tokens stop working: from here the patient's sign-in holds them.
 */
export async function claimIntakes(tx: TenantTx, patientId: string, tokens: readonly string[]): Promise<{ claimed: string[] }> {
  const hashes = [...new Set(tokens)].map(hashToken);
  if (hashes.length === 0) return { claimed: [] };
  await settleIntakes(tx, { tokenHashes: hashes });
  const rows = await tx.db
    .select()
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), inArray(intakes.resumeTokenHash, hashes), isNull(intakes.patientId)))
    .for('update');
  const now = new Date();
  for (const row of rows) {
    await tx.db.update(intakes).set({ patientId, claimedAt: now, resumeTokenHash: null }).where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.id, row.id)));
    await recordIntakeConsent(tx, patientId, { documentId: row.privacyDocumentId, at: row.privacyAgreedAt });
    await audit(tx, { action: 'intake.claimed', zone: 'clinical', recordTable: INTAKES, recordId: row.id });
  }
  return { claimed: rows.map((row) => row.id) };
}
