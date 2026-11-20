import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { oneOf, subsetOf } from './checks.js';
import { protocols } from './clinical-protocols.js';
import { tenants } from './platform.js';
import { MEASUREMENT_KINDS, PROGRAM_STATUSES } from './values.js';
import { operational } from './zones.js';

/**
 * Programs (glossary: a packaged course of care a patient signs up for;
 * docs/decisions/intake.md INT9). A brand sells a program; the program uses
 * one protocol and inherits its condition. Operational, because brand sites
 * and billing show programs; the protocol it points at is clinical. Billing
 * puts prices on programs.
 */
export const programs = operational.table(
  'programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The brand that sells it. The foreign key to platform.brands (tenant_id, id) is added when brands land (INT9). */
    brandId: uuid('brand_id').notNull(),
    protocolId: uuid('protocol_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    /** What a patient on the program records, if anything. */
    measurements: text('measurements').array().notNull().default(sql`'{}'::text[]`),
    /** How often the patient is asked to check in; null for never. */
    checkInEveryDays: integer('check_in_every_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('programs_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.protocolId], foreignColumns: [protocols.tenantId, protocols.id], name: 'programs_protocol_fk' }),
    index('programs_protocol_idx').on(table.tenantId, table.protocolId),
    index('programs_brand_idx').on(table.tenantId, table.brandId),
    check('programs_status_check', oneOf(table.status, PROGRAM_STATUSES)),
    check('programs_measurements_check', subsetOf(table.measurements, MEASUREMENT_KINDS)),
    check('programs_name_check', sql`length(trim(${table.name})) > 0`),
    check('programs_check_in_check', sql`${table.checkInEveryDays} is null or ${table.checkInEveryDays} between 1 and 365`),
  ],
);
