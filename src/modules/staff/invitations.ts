import { env } from '../../config/env.js';

/**
 * The invitation email (docs/decisions/admin.md ADM5). Medora decides who
 * has access; Clerk only delivers the email and lets the person make their
 * sign-in. Sent after the database commits (ADR 0029): a failure leaves the
 * invitation saved, and the screen offers Resend.
 */
export type InvitationEmail = 'sent' | 'failed' | 'not_configured';

export interface InvitationSender {
  send(email: string): Promise<InvitationEmail>;
}

const TIMEOUT_MS = 10_000;

/** Clerk's Backend API. `ignore_existing` makes a second send for the same address a no-op on Clerk's side. */
export const clerkInvitations: InvitationSender = {
  async send(email) {
    if (!env.CLERK_SECRET_KEY || !env.CONSOLE_URL) return 'not_configured';
    try {
      const response = await fetch('https://api.clerk.com/v1/invitations', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          email_address: email,
          redirect_url: new URL('/sign-up', env.CONSOLE_URL).toString(),
          notify: true,
          ignore_existing: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return 'sent';
      // Someone who already has a sign-in can't be invited to make one: they sign in as they are.
      const body = (await response.json().catch(() => null)) as { errors?: { code?: string }[] } | null;
      return body?.errors?.some((error) => error.code === 'form_identifier_exists') ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  },
};

/** The sender the routes use. Tests replace `send` to see what was sent. */
export const invitations: InvitationSender = { send: (email) => clerkInvitations.send(email) };
