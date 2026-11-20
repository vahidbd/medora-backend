import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

/**
 * Phone and SMS, through one Twilio account in its Australian region
 * (ADRs 0005, 0020; docs/decisions/telephony.md). Calls go out after the
 * database commits, from the outbox (ADR 0029), never inside a transaction.
 * In development and tests the fake keeps what it was asked to send.
 */
export interface SmsToSend {
  tenantId: string;
  /** E.164, e.g. +61400000000. */
  to: string;
  from: string;
  body: string;
}

export interface TelephonyClient {
  sendSms(sms: SmsToSend & { statusCallbackUrl: string | null }): Promise<{ providerMessageId: string }>;
}

/** An outside call failed. The message never repeats a number or the text. */
export class TelephonyError extends AppError {
  constructor(code = 'telephony_failed') {
    super(502, code, "The phone and SMS service didn't accept that. Try again in a moment.");
  }
}

const E164 = /^\+[1-9]\d{7,14}$/;

function assertNumbers(sms: SmsToSend): void {
  if (!E164.test(sms.to) || !E164.test(sms.from)) throw new AppError(400, 'invalid_phone_number', 'Phone numbers must be in international form, like +61400000000');
}

class TwilioClient implements TelephonyClient {
  private readonly base = `https://api.${env.TWILIO_EDGE}.${env.TWILIO_REGION}.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}`;
  private readonly authorization = `Basic ${Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString('base64')}`;

  async sendSms(sms: SmsToSend & { statusCallbackUrl: string | null }): Promise<{ providerMessageId: string }> {
    assertNumbers(sms);
    const form = new URLSearchParams({ To: sms.to, From: sms.from, Body: sms.body });
    if (sms.statusCallbackUrl) form.set('StatusCallback', sms.statusCallbackUrl);
    const reply = await this.post('/Messages.json', form);
    if (typeof reply['sid'] !== 'string') throw new TelephonyError();
    return { providerMessageId: reply['sid'] };
  }

  private async post(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { authorization: this.authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TelephonyError('telephony_unreachable');
    }
    if (!response.ok) throw new TelephonyError(`telephony_refused_${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
}

export interface SentSms extends SmsToSend {
  providerMessageId: string;
  statusCallbackUrl: string | null;
}

/** Development and tests only; deployed services refuse TELEPHONY=fake at boot (TEL1). */
export class FakeTelephony implements TelephonyClient {
  readonly sent: SentSms[] = [];

  async sendSms(sms: SmsToSend & { statusCallbackUrl: string | null }): Promise<{ providerMessageId: string }> {
    assertNumbers(sms);
    const providerMessageId = `SMfake${randomUUID().replace(/-/g, '')}`;
    this.sent.push({ ...sms, providerMessageId });
    return { providerMessageId };
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export const fakeTelephony = new FakeTelephony();

let client: TelephonyClient | null = null;

export function telephony(): TelephonyClient {
  client ??= env.TELEPHONY === 'twilio' ? new TwilioClient() : fakeTelephony;
  return client;
}

/** Where Twilio calls back for one tenant: the tenant's id is in the address, so the inbox knows whose it is. */
export function twilioCallbackUrl(tenantId: string, hook: 'sms-inbound' | 'sms-status' | 'voice-status'): string | null {
  if (!env.PUBLIC_API_URL) return null;
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/webhooks/twilio/${tenantId}/${hook}`;
}

/**
 * Send one SMS. Call it after commit, once per outbox row: Twilio has no
 * idempotency key for messages, so a second call sends a second message.
 */
export async function sendSms(sms: SmsToSend): Promise<{ providerMessageId: string }> {
  return telephony().sendSms({ ...sms, statusCallbackUrl: twilioCallbackUrl(sms.tenantId, 'sms-status') });
}
