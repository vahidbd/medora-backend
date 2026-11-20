import { and, desc, eq } from 'drizzle-orm';
import { protocols, protocolVersions } from '../../db/schema/index.js';
import type { ProtocolVersionStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { AppError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { type Definition, definitionProblems, definitionSchema } from './definition.js';
import { findTemplate } from './templates.js';

/**
 * Protocols and their versions (PRD INT-01, INT-03, INT-04;
 * docs/decisions/intake.md INT3 and INT4). A draft is edited; a medical
 * director's sign-off makes it live and retires the one before; a live
 * version can be withdrawn for safety. Signed-off versions never change
 * (the migration's trigger holds that too).
 */

const PROTOCOLS = 'clinical.protocols' as const;
const VERSIONS = 'clinical.protocol_versions' as const;

export interface VersionSummary {
  versionId: string;
  version: number;
  status: ProtocolVersionStatus;
  editedAt: string;
  signedOffAt: string | null;
  signedOffBy: string | null;
  withdrawnAt: string | null;
}

export interface ProtocolSummary {
  protocolId: string;
  name: string;
  condition: string;
  template: { key: string; version: number } | null;
  liveVersion: number | null;
  draftVersion: number | null;
}

export interface ProtocolDetail extends ProtocolSummary {
  versions: VersionSummary[];
}

export interface ProtocolVersionDetail extends VersionSummary {
  protocolId: string;
  definition: Definition;
  signerRegistration: string | null;
  attestation: string | null;
  withdrawnReason: string | null;
}

/** The definition failed the protocol checks: 400 with each problem's path. */
export class DefinitionError extends AppError {
  constructor(problems: { path: string; message: string }[]) {
    super(400, 'protocol_problems', 'The protocol has problems to fix', { problems });
  }
}

function checkedDefinition(input: unknown): Definition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) throw new DefinitionError(parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  const problems = definitionProblems(parsed.data);
  if (problems.length > 0) throw new DefinitionError(problems);
  return parsed.data;
}

function personOf(tx: TenantTx): string {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a staff member can change a protocol', 'person_only');
  return tx.context.actor.userId;
}

const versionColumns = {
  versionId: protocolVersions.id,
  protocolId: protocolVersions.protocolId,
  version: protocolVersions.version,
  status: protocolVersions.status,
  editedAt: protocolVersions.editedAt,
  signedOffAt: protocolVersions.signedOffAt,
  signedOffBy: protocolVersions.signedOffBy,
  withdrawnAt: protocolVersions.withdrawnAt,
};

type VersionRow = { versionId: string; version: number; status: string; editedAt: Date; signedOffAt: Date | null; signedOffBy: string | null; withdrawnAt: Date | null };

const toVersion = (row: VersionRow): VersionSummary => ({
  versionId: row.versionId,
  version: row.version,
  status: row.status as ProtocolVersionStatus,
  editedAt: row.editedAt.toISOString(),
  signedOffAt: row.signedOffAt?.toISOString() ?? null,
  signedOffBy: row.signedOffBy,
  withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
});

async function versionsOf(tx: TenantTx, protocolId?: string) {
  const where = protocolId ? and(eq(protocolVersions.tenantId, tx.context.tenantId), eq(protocolVersions.protocolId, protocolId)) : eq(protocolVersions.tenantId, tx.context.tenantId);
  return tx.db.select(versionColumns).from(protocolVersions).where(where).orderBy(desc(protocolVersions.version));
}

export async function listProtocols(tx: TenantTx): Promise<ProtocolSummary[]> {
  const rows = await tx.db.select().from(protocols).where(eq(protocols.tenantId, tx.context.tenantId)).orderBy(protocols.name);
  const versions = await versionsOf(tx);
  return rows.map((row) => {
    const own = versions.filter((v) => v.protocolId === row.id);
    return {
      protocolId: row.id,
      name: row.name,
      condition: row.condition,
      template: row.templateKey && row.templateVersion ? { key: row.templateKey, version: row.templateVersion } : null,
      liveVersion: own.find((v) => v.status === 'live')?.version ?? null,
      draftVersion: own.find((v) => v.status === 'draft')?.version ?? null,
    };
  });
}

export async function getProtocol(tx: TenantTx, protocolId: string): Promise<ProtocolDetail> {
  const summary = (await listProtocols(tx)).find((p) => p.protocolId === protocolId);
  if (!summary) throw new NotFoundError('Protocol');
  return { ...summary, versions: (await versionsOf(tx, protocolId)).map(toVersion) };
}

export async function getProtocolVersion(tx: TenantTx, protocolId: string, version: number): Promise<ProtocolVersionDetail> {
  const [row] = await tx.db
    .select({
      ...versionColumns,
      definition: protocolVersions.definition,
      signerRegistration: protocolVersions.signerRegistration,
      attestation: protocolVersions.attestation,
      withdrawnReason: protocolVersions.withdrawnReason,
    })
    .from(protocolVersions)
    .where(and(eq(protocolVersions.tenantId, tx.context.tenantId), eq(protocolVersions.protocolId, protocolId), eq(protocolVersions.version, version)));
  if (!row) throw new NotFoundError('Protocol version');
  return {
    ...toVersion(row),
    protocolId,
    definition: row.definition as Definition,
    signerRegistration: row.signerRegistration,
    attestation: row.attestation,
    withdrawnReason: row.withdrawnReason,
  };
}

/** The live version a new intake pins (INT3), or null when the protocol has none. */
export async function liveVersionOf(tx: TenantTx, protocolId: string): Promise<{ versionId: string; version: number; definition: Definition } | null> {
  const [row] = await tx.db
    .select({ versionId: protocolVersions.id, version: protocolVersions.version, definition: protocolVersions.definition })
    .from(protocolVersions)
    .where(and(eq(protocolVersions.tenantId, tx.context.tenantId), eq(protocolVersions.protocolId, protocolId), eq(protocolVersions.status, 'live')));
  return row ? { ...row, definition: row.definition as Definition } : null;
}

export interface NewProtocol {
  name: string;
  condition?: string | undefined;
  templateKey?: string | undefined;
  definition?: unknown;
}

/** A new protocol with version 1 as a draft: copied from a platform template, or from a definition given. */
export async function createProtocol(tx: TenantTx, input: NewProtocol): Promise<ProtocolDetail> {
  const userId = personOf(tx);
  const template = input.templateKey ? findTemplate(input.templateKey) : null;
  if (input.templateKey && !template) throw new NotFoundError('Protocol template');
  const condition = input.condition ?? template?.condition;
  if (!condition) throw new BusinessRuleError('Name the condition this protocol treats', 'condition_needed');
  const definition = checkedDefinition(template ? template.definition : input.definition);
  const tenantId = tx.context.tenantId;
  const [protocol] = await tx.db
    .insert(protocols)
    .values({ tenantId, name: input.name, condition, templateKey: template?.key ?? null, templateVersion: template?.version ?? null, createdBy: userId })
    .onConflictDoNothing()
    .returning({ id: protocols.id });
  if (!protocol) throw new BusinessRuleError('There is already a protocol with that name', 'name_taken');
  const [version] = await tx.db.insert(protocolVersions).values({ tenantId, protocolId: protocol.id, version: 1, definition, editedBy: userId }).returning({ id: protocolVersions.id });
  await audit(tx, { action: 'protocol.created', zone: 'clinical', recordTable: PROTOCOLS, recordId: protocol.id, details: { template: template?.key ?? null } });
  await audit(tx, { action: 'protocol_version.drafted', zone: 'clinical', recordTable: VERSIONS, recordId: version!.id, details: { version: 1 } });
  return getProtocol(tx, protocol.id);
}

async function lockDraft(tx: TenantTx, protocolId: string) {
  const [draft] = await tx.db
    .select({ id: protocolVersions.id, version: protocolVersions.version })
    .from(protocolVersions)
    .where(and(eq(protocolVersions.tenantId, tx.context.tenantId), eq(protocolVersions.protocolId, protocolId), eq(protocolVersions.status, 'draft')))
    .for('update');
  return draft ?? null;
}

/** Replace the draft's definition. Only a draft is ever edited (INT3). */
export async function updateDraft(tx: TenantTx, protocolId: string, input: unknown): Promise<ProtocolVersionDetail> {
  const userId = personOf(tx);
  const draft = await lockDraft(tx, protocolId);
  if (!draft) throw new BusinessRuleError('This protocol has no draft. Start a new version to make changes.', 'no_draft');
  const definition = checkedDefinition(input);
  await tx.db.update(protocolVersions).set({ definition, editedBy: userId, editedAt: new Date() }).where(and(eq(protocolVersions.tenantId, tx.context.tenantId), eq(protocolVersions.id, draft.id)));
  await audit(tx, { action: 'protocol_version.edited', zone: 'clinical', recordTable: VERSIONS, recordId: draft.id, details: { version: draft.version } });
  return getProtocolVersion(tx, protocolId, draft.version);
}

/** Start the next version as a draft, copied from the newest version. */
export async function startDraft(tx: TenantTx, protocolId: string): Promise<ProtocolVersionDetail> {
  const userId = personOf(tx);
  const tenantId = tx.context.tenantId;
  const [protocol] = await tx.db.select({ id: protocols.id }).from(protocols).where(and(eq(protocols.tenantId, tenantId), eq(protocols.id, protocolId)));
  if (!protocol) throw new NotFoundError('Protocol');
  const [latest] = await tx.db
    .select({ version: protocolVersions.version, definition: protocolVersions.definition })
    .from(protocolVersions)
    .where(and(eq(protocolVersions.tenantId, tenantId), eq(protocolVersions.protocolId, protocolId)))
    .orderBy(desc(protocolVersions.version))
    .limit(1);
  // Version 1 is made with the protocol, so there is always one to copy.
  const version = latest!.version + 1;
  // The one-draft index refuses a second draft, including one started at the same moment.
  const [row] = await tx.db
    .insert(protocolVersions)
    .values({ tenantId, protocolId, version, definition: latest!.definition, editedBy: userId })
    .onConflictDoNothing()
    .returning({ id: protocolVersions.id });
  if (!row) throw new BusinessRuleError('This protocol already has a draft', 'draft_exists');
  await audit(tx, { action: 'protocol_version.drafted', zone: 'clinical', recordTable: VERSIONS, recordId: row.id, details: { version } });
  return getProtocolVersion(tx, protocolId, version);
}

/** An Ahpra registration number for a medical practitioner: MED and ten digits (INT4). */
export const MEDICAL_REGISTRATION = /^MED\d{10}$/;

/**
 * A medical director signs off the draft, which makes it live and retires
 * the live one (INT4). Needs a person, `protocols:sign_off` (checked by the
 * route), a medical practitioner's Ahpra registration and the attestation.
 */
export async function signOff(tx: TenantTx, protocolId: string, input: { version: number; registration: string }): Promise<ProtocolVersionDetail> {
  const userId = personOf(tx);
  const tenantId = tx.context.tenantId;
  if (!MEDICAL_REGISTRATION.test(input.registration)) {
    throw new BusinessRuleError('Sign off under your Ahpra registration as a medical practitioner (MED and ten digits)', 'registration_needed');
  }
  const draft = await lockDraft(tx, protocolId);
  if (!draft || draft.version !== input.version) throw new BusinessRuleError('Only the current draft can be signed off', 'not_a_draft');
  const current = await getProtocolVersion(tx, protocolId, draft.version);
  checkedDefinition(current.definition);
  const [protocol] = await tx.db.select({ name: protocols.name }).from(protocols).where(and(eq(protocols.tenantId, tenantId), eq(protocols.id, protocolId)));
  const now = new Date();
  const [retired] = await tx.db
    .update(protocolVersions)
    .set({ status: 'retired', retiredAt: now })
    .where(and(eq(protocolVersions.tenantId, tenantId), eq(protocolVersions.protocolId, protocolId), eq(protocolVersions.status, 'live')))
    .returning({ id: protocolVersions.id, version: protocolVersions.version });
  const attestation = `I have reviewed version ${draft.version} of the protocol "${protocol!.name}" and approve it for use with patients, under Ahpra registration ${input.registration}.`;
  await tx.db
    .update(protocolVersions)
    .set({ status: 'live', signedOffBy: userId, signedOffAt: now, signerRegistration: input.registration, attestation })
    .where(and(eq(protocolVersions.tenantId, tenantId), eq(protocolVersions.id, draft.id)));
  await audit(tx, { action: 'protocol_version.signed_off', zone: 'clinical', recordTable: VERSIONS, recordId: draft.id, details: { version: draft.version, retired: retired?.version ?? null } });
  await emitEvent(tx, { type: 'protocol_version.live', recordTable: VERSIONS, recordId: draft.id, payload: { protocolId, version: draft.version } });
  return getProtocolVersion(tx, protocolId, draft.version);
}

/**
 * Take the live version off for safety (INT4). New intakes stop; intakes in
 * progress on it can't be submitted; completed ones show the prescriber it
 * was withdrawn.
 */
export async function withdrawLive(tx: TenantTx, protocolId: string, reason: string): Promise<ProtocolVersionDetail> {
  const userId = personOf(tx);
  const tenantId = tx.context.tenantId;
  const [withdrawn] = await tx.db
    .update(protocolVersions)
    .set({ status: 'withdrawn', withdrawnBy: userId, withdrawnAt: new Date(), withdrawnReason: reason })
    .where(and(eq(protocolVersions.tenantId, tenantId), eq(protocolVersions.protocolId, protocolId), eq(protocolVersions.status, 'live')))
    .returning({ id: protocolVersions.id, version: protocolVersions.version });
  if (!withdrawn) throw new BusinessRuleError('This protocol has no live version to withdraw', 'nothing_live');
  await audit(tx, { action: 'protocol_version.withdrawn', zone: 'clinical', recordTable: VERSIONS, recordId: withdrawn.id, details: { version: withdrawn.version, reason } });
  await emitEvent(tx, { type: 'protocol_version.withdrawn', recordTable: VERSIONS, recordId: withdrawn.id, payload: { protocolId, version: withdrawn.version } });
  return getProtocolVersion(tx, protocolId, withdrawn.version);
}

