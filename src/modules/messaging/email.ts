import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Sending email (docs/decisions/messaging.md CRM3). One interface, so the
 * provider can be chosen without touching callers. Email carries patient
 * text, so the provider must store and process it in Australia (ADR 0005);
 * it is not chosen yet, and until it is only the fake exists, which
 * production refuses (src/config/env.ts).
 */
export interface EmailToSend {
  tenantId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Our own Message-ID and the one being answered, so replies thread onto the ticket. */
  headers: Record<string, string>;
}

export interface EmailSender {
  send(email: EmailToSend): Promise<{ providerMessageId: string }>;
}

export class EmailError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Email was not accepted (${code})`);
    this.name = 'EmailError';
    this.code = code;
  }
}

/** Records what would have been sent. Development, tests and preview only. */
export const fakeEmail = {
  sent: [] as EmailToSend[],
  /** The next send fails with this code (tests of the failure path). */
  failNext: null as string | null,
  reset(): void {
    this.sent.length = 0;
    this.failNext = null;
  },
  async send(email: EmailToSend): Promise<{ providerMessageId: string }> {
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      throw new EmailError(code);
    }
    this.sent.push(email);
    return { providerMessageId: `fake-${randomUUID()}` };
  },
};

/** Email is switched off for this service (EMAIL=none): the sender refuses, so nothing is lost silently. */
const noEmail: EmailSender = {
  send: async () => {
    throw new EmailError('email_off');
  },
};

export function emailSender(): EmailSender {
  switch (env.EMAIL) {
    case 'fake':
      return fakeEmail;
    case 'none':
      return noEmail;
  }
}

export const emailIsOn = (): boolean => env.EMAIL !== 'none';
