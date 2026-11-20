import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema/index.js';

/**
 * One owner per table (ADR 0027): only the owning module or helper writes it;
 * everyone else calls the owner's front door. A table with no owner here is
 * written only by migrations' reviewed functions and the development seed.
 */
const OWNERS: Record<string, string[]> = {
  'platform.tenants': ['src/modules/brands/'],
  'platform.companies': ['src/modules/brands/'],
  'platform.brands': ['src/modules/brands/'],
  'platform.brand_domains': ['src/modules/brands/'],
  'platform.users': [],
  'platform.memberships': ['src/modules/staff/'],
  'platform.roles': ['src/modules/staff/'],
  'platform.break_glass': ['src/modules/staff/'],
  'platform.sign_ins': ['src/db/session.ts'],
  'platform.audit_log': ['src/lib/audit.ts'],
  'platform.outbox': ['src/lib/events.ts', 'src/lib/outbox-delivery.ts'],
  'platform.outbox_deliveries': ['src/lib/outbox-delivery.ts'],
  'platform.job_leases': ['src/lib/leases.ts'],
  'platform.rate_limit_counters': ['src/lib/rate-limit.ts'],
  'platform.webhook_inbox': ['src/lib/webhooks.ts'],
  'platform.tenant_keys': ['src/lib/field-crypto.ts'],
  'clinical.patients': ['src/modules/patients/'],
  'clinical.patient_contacts': ['src/modules/patients/'],
  'clinical.patient_addresses': ['src/modules/patients/'],
  'clinical.patient_sign_ins': ['src/modules/patients/'],
  'clinical.consent_documents': ['src/modules/patients/'],
  'clinical.patient_consents': ['src/modules/patients/'],
  'clinical.messages': ['src/modules/messaging/'],
  'operational.senders': ['src/modules/messaging/'],
};

/** Made-up local data only (src/db/seed.ts refuses anything but development). */
const SEED = 'src/db/seed.ts';

const tables = Object.entries(schema)
  .filter(([, value]) => is(value, PgTable))
  .map(([exportName, value]) => {
    const config = getTableConfig(value as PgTable);
    return { exportName, name: `${config.schema ?? 'public'}.${config.name}` };
  });

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(dir, file).split('\\').join('/'));
}

function writers(table: { exportName: string; name: string }): string[] {
  const drizzleWrite = new RegExp(`\\.(insert|update|delete)\\(\\s*${table.exportName}\\b`);
  const [schemaName, tableName] = table.name.split('.');
  const sqlWrite = new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+"?${schemaName}"?\\."?${tableName}"?\\b`, 'i');
  return sourceFiles('src').filter((file) => {
    const text = readFileSync(file, 'utf8');
    return drizzleWrite.test(text) || sqlWrite.test(text);
  });
}

describe('table owners (ADR 0027)', () => {
  it('lists an owner for every table', () => {
    expect(tables.map((t) => t.name).sort()).toEqual(Object.keys(OWNERS).sort());
  });

  it.each(tables)('$name is written only by its owner', (table) => {
    const owners = OWNERS[table.name] ?? [];
    const strangers = writers(table).filter((file) => file !== SEED && !owners.some((owner) => file.startsWith(owner)));
    expect(strangers).toEqual([]);
  });
});
