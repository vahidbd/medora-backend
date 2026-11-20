import { z } from 'zod';

/** How a patient wants to hear from their care (docs/decisions/notifications.md). Field names follow GLOSSARY.md. */
export const notificationPreferencesSchema = z
  .object({
    /** Texts as well as emails (NTF1). */
    sms: z.boolean(),
    /** Reminders to check in, record a reading or reorder (NTF2). */
    reminders: z.boolean(),
  })
  .strict();

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
