import { z } from 'zod';
import { INTAKE_END_REASONS, INTAKE_STATUSES } from '../../db/schema/values.js';

/** Request and reply shapes for intakes (ADR 0014, docs/decisions/intake.md). */

const instant = z.iso.datetime({ offset: true });
const answerValue = z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]);

export const intakeParams = z.object({ intakeId: z.uuid() });
export const stepParams = z.object({ intakeId: z.uuid(), stepKey: z.string().max(48) });
export const programParams = z.object({ programId: z.uuid() });
export const patientParams = z.object({ patientId: z.uuid() });

const question = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string().optional(),
  kind: z.string(),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const intakeView = z.object({
  intakeId: z.uuid(),
  programId: z.uuid(),
  programName: z.string(),
  status: z.enum(INTAKE_STATUSES),
  endedReason: z.enum(INTAKE_END_REASONS).nullable(),
  steps: z.array(z.object({ key: z.string(), title: z.string(), intro: z.string().optional(), done: z.boolean(), questions: z.array(question) })),
  currentStep: z.string().nullable(),
  answers: z.record(z.string(), answerValue),
  stop: z.object({ message: z.string(), urgentHelp: z.boolean() }).nullable(),
  readyToSubmit: z.boolean(),
  startedAt: instant,
  submittedAt: instant.nullable(),
});

export const startScreenReply = z.object({
  programId: z.uuid(),
  programName: z.string(),
  privacyNotice: z.object({ documentId: z.uuid(), version: z.number().int(), title: z.string(), body: z.string() }),
});

export const anonymousStartBody = z
  .object({
    programId: z.uuid(),
    /** The privacy notice version shown on the first screen and agreed to. */
    privacyDocumentId: z.uuid(),
    /** "I am 18 or older", ticked on the first screen. */
    adult: z.literal(true),
    dateOfBirth: z.string().max(10),
  })
  .strict();

export const stepBody = z.object({ answers: z.record(z.string(), z.unknown()) }).strict();
export const patientStartBody = z.object({ programId: z.uuid() }).strict();
export const claimBody = z.object({ tokens: z.array(z.string().min(20).max(100)).min(1).max(20) }).strict();
export const claimReply = z.object({ claimed: z.array(z.uuid()) });

export const intakeList = z.object({
  intakes: z.array(
    z.object({
      intakeId: z.uuid(),
      programId: z.uuid(),
      programName: z.string(),
      status: z.enum(INTAKE_STATUSES),
      endedReason: z.enum(INTAKE_END_REASONS).nullable(),
      startedAt: instant,
      submittedAt: instant.nullable(),
      endedAt: instant.nullable(),
    }),
  ),
});

const ruleLine = z.object({ rule: z.string(), message: z.string() });
export const intakeSummary = z.object({
  intakeId: z.uuid(),
  patientId: z.uuid(),
  programId: z.uuid(),
  programName: z.string(),
  protocolName: z.string(),
  protocolVersion: z.number().int(),
  versionWithdrawn: z.boolean(),
  status: z.enum(['completed', 'ineligible']),
  submittedAt: instant,
  outcome: z.enum(['clear', 'red_flags', 'ineligible']),
  stale: z.boolean(),
  dateOfBirthDiffers: z.boolean(),
  stop: ruleLine.nullable(),
  redFlags: z.array(ruleLine),
  derived: z.array(z.object({ key: z.string(), label: z.string(), value: z.number().nullable(), unit: z.string().nullable() })),
  items: z.array(z.object({ questionKey: z.string(), question: z.string(), answer: z.string(), redFlag: z.boolean() })),
  earlierIneligible: z.array(z.object({ intakeId: z.uuid(), submittedAt: instant, rule: z.string() })),
});
