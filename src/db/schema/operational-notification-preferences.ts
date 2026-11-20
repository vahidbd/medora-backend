import { boolean, foreignKey, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { patients } from './clinical-patients.js';
import { operational } from './zones.js';

/**
 * How a patient wants to hear from their care (docs/decisions/notifications.md
 * NTF1). Email always: it is how they sign in. A row exists only once the
 * patient changes something; until then the defaults hold. Operational, not
 * clinical: it says how to reach someone, nothing about their health.
 */
export const notificationPreferences = operational.table(
  'notification_preferences',
  {
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    /** Texts as well as emails, to the mobile on the record. */
    sms: boolean('sms').notNull().default(true),
    /** Reminders to check in, record a reading or reorder; never what the care team writes. */
    reminders: boolean('reminders').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.patientId], name: 'notification_preferences_pkey' }),
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'notification_preferences_patient_fk' }),
  ],
);
