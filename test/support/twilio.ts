import type { App } from '../../src/app.js';
import { twilioSignature } from '../../src/modules/telephony/index.js';

/** Posts a webhook the way Twilio does: form fields, signed over the public address with the test auth token. */
export async function postTwilioWebhook(app: App, path: string, fields: Record<string, string>, options: { signature?: string } = {}) {
  const params = new URLSearchParams(fields);
  const url = `${process.env.PUBLIC_API_URL}${path}`;
  const signature = options.signature ?? twilioSignature(process.env.TWILIO_AUTH_TOKEN ?? '', url, params);
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    payload: params.toString(),
  });
}
