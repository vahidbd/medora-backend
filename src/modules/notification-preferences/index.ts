/**
 * Notification preferences: how a patient wants to hear from their care
 * (docs/decisions/notifications.md). The module's front door (ADR 0027):
 * whatever sends to a patient calls notificationPreferencesOf first.
 */
export { notificationPreferencesRoutes } from './notification-preferences.routes.js';
export { DEFAULT_PREFERENCES, notificationPreferencesOf } from './notification-preferences.service.js';
export type { NotificationPreferences } from './notification-preferences.schemas.js';
