import { z } from 'zod';
import { SENDER_CHANNELS, SENDER_PURPOSES } from '../../db/schema/values.js';

export const sender = z.object({
  senderId: z.uuid(),
  brandId: z.uuid(),
  channel: z.enum(SENDER_CHANNELS),
  purpose: z.enum(SENDER_PURPOSES),
  address: z.string(),
  updatedAt: z.date(),
});

export const senderListReply = z.object({ senders: z.array(sender) });

export const senderBody = z
  .object({
    brandId: z.uuid(),
    channel: z.enum(SENDER_CHANNELS),
    purpose: z.enum(SENDER_PURPOSES),
    address: z.string().trim().min(3).max(254),
  })
  .strict();

export const senderParams = z.object({ senderId: z.uuid() });
export const removedReply = z.object({ removed: z.literal(true) });
