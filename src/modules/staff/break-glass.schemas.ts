import { z } from 'zod';

export const breakGlassRecord = z.object({
  breakGlassId: z.uuid(),
  membershipId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  reason: z.string(),
  openedAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewNote: z.string().nullable(),
});

export const openBody = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export const reviewBody = z.object({ note: z.string().trim().max(500).default('') }).strict();
export const breakGlassParams = z.object({ breakGlassId: z.uuid() });
export const breakGlassQuery = z.object({ unreviewed: z.enum(['true', 'false']).default('true') });
export const breakGlassListReply = z.object({ breakGlass: z.array(breakGlassRecord) });
