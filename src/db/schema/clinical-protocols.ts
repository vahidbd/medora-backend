import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants, users } from './platform.js';
import { PROTOCOL_VERSION_STATUSES } from './values.js';
import { clinical } from './zones.js';

/**
 * Protocols (PRD INT-01 to INT-04, docs/decisions/intake.md): a tenant's
 * clinical rules for one condition, as numbered versions. A version's
 * definition holds its questions, derived numbers and rules; it is edited
 * only as a draft, and a medical director's sign-off makes it live. Tenant
 * data, never code (ADR 0023).
 */
export const protocols = clinical.table(
  'protocols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    /** What the protocol treats, in the tenant's words (glossary: Condition). */
    condition: text('condition').notNull(),
    /** The platform template it was copied from, if any (its key and version). */
    templateKey: text('template_key'),
    templateVersion: integer('template_version'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('protocols_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('protocols_tenant_name_key').on(table.tenantId, sql`lower(${table.name})`),
    index('protocols_created_by_idx').on(table.createdBy),
    check('protocols_text_check', sql`length(trim(${table.name})) > 0 and length(trim(${table.condition})) > 0`),
    check('protocols_template_check', sql`(${table.templateKey} is null) = (${table.templateVersion} is null)`),
  ],
);

export const protocolVersions = clinical.table(
  'protocol_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    protocolId: uuid('protocol_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('draft'),
    /** Steps, questions, derived numbers and rules (src/modules/protocols/definition.ts). */
    definition: jsonb('definition').notNull(),
    editedBy: uuid('edited_by').references(() => users.id),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
    /** Sign-off (INT4): who, when, the registration they signed under and what they attested. */
    signedOffBy: uuid('signed_off_by').references(() => users.id),
    signedOffAt: timestamp('signed_off_at', { withTimezone: true }),
    signerRegistration: text('signer_registration'),
    attestation: text('attestation'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    withdrawnBy: uuid('withdrawn_by').references(() => users.id),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnReason: text('withdrawn_reason'),
  },
  (table) => [
    unique('protocol_versions_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.protocolId], foreignColumns: [protocols.tenantId, protocols.id], name: 'protocol_versions_protocol_fk' }),
    uniqueIndex('protocol_versions_version_key').on(table.tenantId, table.protocolId, table.version),
    /** One live version and one draft per protocol at a time. */
    uniqueIndex('protocol_versions_one_live_key').on(table.tenantId, table.protocolId).where(sql`${table.status} = 'live'`),
    uniqueIndex('protocol_versions_one_draft_key').on(table.tenantId, table.protocolId).where(sql`${table.status} = 'draft'`),
    index('protocol_versions_edited_by_idx').on(table.editedBy),
    index('protocol_versions_signed_off_by_idx').on(table.signedOffBy),
    index('protocol_versions_withdrawn_by_idx').on(table.withdrawnBy),
    check('protocol_versions_status_check', oneOf(table.status, PROTOCOL_VERSION_STATUSES)),
    check('protocol_versions_version_check', sql`${table.version} > 0`),
    check(
      'protocol_versions_sign_off_check',
      sql`(${table.status} = 'draft') = (${table.signedOffAt} is null) and (${table.signedOffAt} is null) = (${table.signedOffBy} is null) and (${table.signedOffAt} is null) = (${table.signerRegistration} is null) and (${table.signedOffAt} is null) = (${table.attestation} is null)`,
    ),
    check('protocol_versions_withdrawn_check', sql`(${table.status} = 'withdrawn') = (${table.withdrawnAt} is not null) and (${table.withdrawnAt} is null) = (${table.withdrawnReason} is null)`),
  ],
);
