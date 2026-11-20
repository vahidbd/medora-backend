/**
 * Telephony: SMS and phone calls through Twilio, and Twilio's webhooks. The
 * module's front door (ADR 0027).
 */
export { telephonyRoutes } from './telephony.routes.js';
export { fakeTelephony, sendSms, telephony, twilioCallbackUrl, TelephonyError, type SentSms, type SmsToSend, type TelephonyClient } from './telephony.client.js';
export { twilioSignature } from './twilio-signature.js';
