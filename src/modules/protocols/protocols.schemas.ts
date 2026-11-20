import { z } from 'zod';
import { MEASUREMENT_KINDS, PROGRAM_STATUSES, PROTOCOL_VERSION_STATUSES } from '../../db/schema/values.js';

/**
 * Request and reply shapes for protocols and programs (ADR 0014). A
 * definition travels as an object: the service checks it against
 * src/modules/protocols/definition.ts and answers 400 `protocol_problems`
 * with each problem's path.
 */

const definition = z.record(z.string(), z.unknown());
const instant = z.iso.datetime({ offset: true });
const name = z.string().trim().min(1).max(120);

export const protocolParams = z.object({ protocolId: z.uuid() });
export const versionParams = z.object({ protocolId: z.uuid(), version: z.coerce.number().int().positive() });
export const programParams = z.object({ programId: z.uuid() });

export const templatesReply = z.object({
  templates: z.array(
    z.object({
      key: z.string(),
      version: z.number().int(),
      name: z.string(),
      condition: z.string(),
      summary: z.string(),
      clinicalReview: z.object({ by: z.string(), on: z.string() }).nullable(),
      definition,
    }),
  ),
});

const versionSummary = z.object({
  versionId: z.uuid(),
  version: z.number().int(),
  status: z.enum(PROTOCOL_VERSION_STATUSES),
  editedAt: instant,
  signedOffAt: instant.nullable(),
  signedOffBy: z.uuid().nullable(),
  withdrawnAt: instant.nullable(),
});

export const protocolSummary = z.object({
  protocolId: z.uuid(),
  name: z.string(),
  condition: z.string(),
  template: z.object({ key: z.string(), version: z.number().int() }).nullable(),
  liveVersion: z.number().int().nullable(),
  draftVersion: z.number().int().nullable(),
});
export const protocolsReply = z.object({ protocols: z.array(protocolSummary) });
export const protocolDetail = protocolSummary.extend({ versions: z.array(versionSummary) });
export const versionDetail = versionSummary.extend({
  protocolId: z.uuid(),
  definition,
  signerRegistration: z.string().nullable(),
  attestation: z.string().nullable(),
  withdrawnReason: z.string().nullable(),
});

export const newProtocolBody = z
  .object({
    name,
    condition: name.optional(),
    /** Copy a platform template; or give a definition of your own. */
    templateKey: z.string().max(60).optional(),
    definition: definition.optional(),
  })
  .strict()
  .refine((body) => (body.templateKey === undefined) !== (body.definition === undefined), 'Give a template or a definition, not both');

export const draftBody = z.object({ definition }).strict();
export const signOffBody = z
  .object({
    version: z.number().int().positive(),
    /** The signer's Ahpra registration as a medical practitioner. */
    registration: z.string().trim().toUpperCase().max(20),
    /** The signer confirms the attestation shown to them. */
    attest: z.literal(true),
  })
  .strict();
export const withdrawBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const measurements = z.array(z.enum(MEASUREMENT_KINDS)).max(MEASUREMENT_KINDS.length);
const checkInEveryDays = z.number().int().min(1).max(365).nullable();

export const program = z.object({
  programId: z.uuid(),
  brandId: z.uuid(),
  protocolId: z.uuid(),
  condition: z.string(),
  name: z.string(),
  status: z.enum(PROGRAM_STATUSES),
  measurements,
  checkInEveryDays,
});
export const programsReply = z.object({ programs: z.array(program) });
export const newProgramBody = z.object({ brandId: z.uuid(), protocolId: z.uuid(), name, measurements: measurements.default([]), checkInEveryDays: checkInEveryDays.default(null) }).strict();
export const programChangeBody = z
  .object({ name: name.optional(), measurements: measurements.optional(), checkInEveryDays: checkInEveryDays.optional(), status: z.enum(PROGRAM_STATUSES).optional() })
  .strict();
