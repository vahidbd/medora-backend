import { and, desc, eq, inArray } from 'drizzle-orm';
import { intakes } from '../../db/schema/index.js';
import type { IntakeEndReason, IntakeStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { localDate } from '../../lib/time.js';
import { ageOn, findPatient } from '../patients/index.js';
import { type AnswerValue, deriveNumbers, type Definition, listPrograms, protocolVersionById, type Question, questionIndex, shownFlow } from '../protocols/index.js';
import { answersOf, INTAKES, tenantTimeZone } from './intakes.service.js';
import { settleIntakes } from './upkeep.js';

/**
 * What staff and the patient app see of intakes (docs/decisions/intake.md
 * INT11, INT15). Status lists carry no answers; the prescriber's summary is
 * the clinical read, audited.
 */

/** A completed intake older than this at consult is highlighted to the prescriber. */
export const STALE_DAYS = 30;

export interface IntakeListItem {
  intakeId: string;
  programId: string;
  programName: string;
  status: IntakeStatus;
  endedReason: IntakeEndReason | null;
  startedAt: string;
  submittedAt: string | null;
  endedAt: string | null;
}

/** A patient's intakes, newest first, without answers or rules. */
export async function intakesOf(tx: TenantTx, patientId: string): Promise<IntakeListItem[]> {
  const rows = await tx.db
    .select()
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.patientId, patientId)))
    .orderBy(desc(intakes.startedAt));
  const names = new Map((await listPrograms(tx)).map((program) => [program.programId, program.name]));
  await audit(tx, { action: 'intake.listed', zone: 'clinical', recordTable: INTAKES, recordId: patientId });
  return rows.map((row) => ({
    intakeId: row.id,
    programId: row.programId,
    programName: names.get(row.programId) ?? '',
    status: row.status as IntakeStatus,
    endedReason: (row.endedReason as IntakeEndReason | null) ?? null,
    startedAt: row.startedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  }));
}

export interface PatientProgram {
  programId: string;
  name: string;
  measurements: string[];
  checkInEveryDays: number | null;
}

/** The programs a patient has a completed intake for, for the patient app (`/patient/me`). */
export async function programsOfPatient(tx: TenantTx, patientId: string): Promise<PatientProgram[]> {
  const rows = await tx.db
    .selectDistinct({ programId: intakes.programId })
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.patientId, patientId), eq(intakes.status, 'completed')));
  const wanted = new Set(rows.map((row) => row.programId));
  return (await listPrograms(tx))
    .filter((program) => wanted.has(program.programId))
    .map(({ programId, name, measurements, checkInEveryDays }) => ({ programId, name, measurements, checkInEveryDays }));
}

export interface IntakeSummary {
  intakeId: string;
  patientId: string;
  programId: string;
  programName: string;
  protocolName: string;
  protocolVersion: number;
  /** The version was withdrawn for safety after this was answered (INT4). */
  versionWithdrawn: boolean;
  status: 'completed' | 'ineligible';
  /** When it was sent, or for an ineligible one, when the hard stop ended it. */
  submittedAt: string;
  outcome: 'clear' | 'red_flags' | 'ineligible';
  /** Answered more than 30 days before today (INT15). */
  stale: boolean;
  /** The date of birth on the intake isn't the one on the patient's record. */
  dateOfBirthDiffers: boolean;
  stop: { rule: string; message: string } | null;
  redFlags: { rule: string; message: string }[];
  derived: { key: string; label: string; value: number | null; unit: string | null }[];
  items: { questionKey: string; question: string; answer: string; redFlag: boolean }[];
  earlierIneligible: { intakeId: string; submittedAt: string; rule: string }[];
}

function shownAnswer(question: Question, value: AnswerValue): string {
  const label = (v: string) => question.options?.find((option) => option.value === v)?.label ?? v;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.map(label).join('; ');
  if (typeof value === 'number') return question.unit ? `${value} ${question.unit}` : String(value);
  return question.kind === 'single_choice' ? label(value) : value;
}

/** Every question a rule reads, through its conditions (for marking the answers behind a red flag). */
function keysRead(condition: Definition['rules'][number]['when']): string[] {
  if ('all' in condition) return condition.all.flatMap(keysRead);
  if ('any' in condition) return condition.any.flatMap(keysRead);
  if ('not' in condition) return keysRead(condition.not);
  return 'answer' in condition ? [condition.answer] : [];
}

async function summarise(tx: TenantTx, row: typeof intakes.$inferSelect, today: Date): Promise<IntakeSummary> {
  const version = await protocolVersionById(tx, row.protocolVersionId);
  const { definition } = version;
  const patient = await findPatient(tx, row.patientId!);
  const program = (await listPrograms(tx)).find((p) => p.programId === row.programId);
  // Age on the day it was answered, on the tenant's calendar, as the rules saw it (INT13).
  const age = row.dateOfBirth ? ageOn(row.dateOfBirth, localDate(row.submittedAt ?? row.endedAt ?? today, await tenantTimeZone(tx))) : null;
  const answers = shownFlow(definition, await answersOf(tx, row), age).answers;
  const derivedValues = deriveNumbers(definition, answers, age);
  const flagged = definition.rules.filter((rule) => rule.outcome === 'red_flag' && row.redFlags.includes(rule.key));
  const flaggedKeys = new Set(flagged.flatMap((rule) => keysRead(rule.when)));
  const stopRule = row.stoppedRule ? definition.rules.find((rule) => rule.key === row.stoppedRule) : undefined;
  const index = questionIndex(definition);
  const at = (row.submittedAt ?? row.endedAt)!;
  const earlier = await tx.db
    .select()
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.patientId, row.patientId!), eq(intakes.status, 'ineligible')))
    .orderBy(desc(intakes.endedAt));
  const earlierIneligible = [];
  for (const other of earlier.filter((o) => o.id !== row.id && o.endedAt && o.endedAt <= at)) {
    const otherVersion = await protocolVersionById(tx, other.protocolVersionId);
    const rule = otherVersion.definition.rules.find((r) => r.key === other.stoppedRule);
    earlierIneligible.push({ intakeId: other.id, submittedAt: other.endedAt!.toISOString(), rule: rule?.prescriberLabel ?? other.stoppedRule ?? '' });
  }
  return {
    intakeId: row.id,
    patientId: row.patientId!,
    programId: row.programId,
    programName: program?.name ?? '',
    protocolName: version.protocolName,
    protocolVersion: version.version,
    versionWithdrawn: version.status === 'withdrawn',
    status: row.status as 'completed' | 'ineligible',
    submittedAt: at.toISOString(),
    outcome: row.status === 'ineligible' ? 'ineligible' : flagged.length > 0 ? 'red_flags' : 'clear',
    stale: today.getTime() - at.getTime() > STALE_DAYS * 86_400_000,
    dateOfBirthDiffers: Boolean(patient && row.dateOfBirth && patient.dateOfBirth !== row.dateOfBirth),
    stop: stopRule ? { rule: stopRule.key, message: stopRule.prescriberLabel } : null,
    redFlags: flagged.map((rule) => ({ rule: rule.key, message: rule.prescriberLabel })),
    derived: definition.derived.map((item) => ({ key: item.key, label: item.label, value: derivedValues.get(item.key) ?? null, unit: item.unit ?? null })),
    items: Object.entries(answers)
      .map(([key, value]) => ({ key, value, found: index.get(key) }))
      .filter((entry) => entry.found)
      .sort((a, b) => a.found!.step - b.found!.step || definition.steps[a.found!.step]!.questions.indexOf(a.found!.question) - definition.steps[b.found!.step]!.questions.indexOf(b.found!.question))
      .map(({ key, value, found }) => ({ questionKey: key, question: found!.question.label, answer: shownAnswer(found!.question, value), redFlag: flaggedKeys.has(key) })),
    earlierIneligible,
  };
}

async function auditSummaryRead(tx: TenantTx, intakeId: string): Promise<void> {
  await audit(tx, { action: 'intake.summary_read', zone: 'clinical', recordTable: INTAKES, recordId: intakeId });
}

/** One finished intake's summary for the prescriber (INT15). Not found while it is in progress or ended without a stop. */
export async function intakeSummary(tx: TenantTx, intakeId: string): Promise<IntakeSummary> {
  await settleIntakes(tx, { intakeId });
  const [row] = await tx.db
    .select()
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.id, intakeId), inArray(intakes.status, ['completed', 'ineligible'])));
  if (!row?.patientId) throw new NotFoundError('Intake');
  await auditSummaryRead(tx, row.id);
  return summarise(tx, row, new Date());
}

/**
 * The patient's latest completed intake, summarised for the consult, or
 * null when they have none (the clinical record calls this through the
 * front door).
 */
export async function intakeSummaryFor(tx: TenantTx, patientId: string): Promise<IntakeSummary | null> {
  const [row] = await tx.db
    .select()
    .from(intakes)
    .where(and(eq(intakes.tenantId, tx.context.tenantId), eq(intakes.patientId, patientId), eq(intakes.status, 'completed')))
    .orderBy(desc(intakes.submittedAt))
    .limit(1);
  if (!row) return null;
  await auditSummaryRead(tx, row.id);
  return summarise(tx, row, new Date());
}
