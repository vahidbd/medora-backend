import { z } from 'zod';

export const openParchmentBody = z.object({ patientId: z.uuid() }).strict();

export const openedSessionReply = z.object({
  sessionId: z.uuid(),
  consultId: z.uuid(),
  /** Parchment's page for this patient, opened in a new tab. */
  parchmentUrl: z.url(),
});
