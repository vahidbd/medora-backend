import { and, eq } from 'drizzle-orm';
import { notificationPreferences } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import type { NotificationPreferences } from './notification-preferences.schemas.js';

/** What holds until the patient changes something (NTF1, NTF2). */
export const DEFAULT_PREFERENCES: NotificationPreferences = { sms: true, reminders: true };

const RECORD = 'operational.notification_preferences';

/** The patient's preferences, or the defaults. Whatever sends to a patient reads this first. */
export async function notificationPreferencesOf(tx: TenantTx, patientId: string): Promise<NotificationPreferences> {
  const [row] = await tx.db
    .select({ sms: notificationPreferences.sms, reminders: notificationPreferences.reminders })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.tenantId, tx.context.tenantId), eq(notificationPreferences.patientId, patientId)));
  return row ?? DEFAULT_PREFERENCES;
}

/** Sets both preferences at once, and audits what they became. */
export async function setNotificationPreferences(tx: TenantTx, patientId: string, preferences: NotificationPreferences): Promise<NotificationPreferences> {
  const values = { sms: preferences.sms, reminders: preferences.reminders, updatedAt: new Date() };
  const [row] = await tx.db
    .insert(notificationPreferences)
    .values({ tenantId: tx.context.tenantId, patientId, ...values })
    .onConflictDoUpdate({ target: [notificationPreferences.tenantId, notificationPreferences.patientId], set: values })
    .returning({ sms: notificationPreferences.sms, reminders: notificationPreferences.reminders });
  if (!row) throw new Error('The preferences were not written');
  await audit(tx, { action: 'notification_preferences.changed', zone: 'operational', recordTable: RECORD, recordId: patientId, details: { patientId, ...row } });
  return row;
}
