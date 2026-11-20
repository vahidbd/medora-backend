import { z } from 'zod';
import {
  ACTOR_TYPES,
  CHANNELS,
  MACRO_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  TICKET_FLAGS,
  TICKET_PRIORITIES,
  TICKET_QUEUES,
  TICKET_STATUSES,
  TICKET_TOPICS,
  VERIFICATION_METHODS,
} from '../../db/schema/values.js';

const instant = z.string();
const text = (max: number) => z.string().trim().min(1).max(max);

export const ticketParams = z.object({ ticketId: z.uuid() });
export const flagParams = z.object({
  ticketId: z.uuid(),
  flag: z.enum(TICKET_FLAGS),
});
export const macroParams = z.object({ macroId: z.uuid() });

export const ticketListQuery = z
  .object({
    queue: z.enum(TICKET_QUEUES).optional(),
    status: z.enum([...TICKET_STATUSES, 'active']).optional(),
    assignee: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
    brandId: z.uuid().optional(),
    patientId: z.uuid().optional(),
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const ticketSummary = {
  ticketId: z.uuid(),
  brandId: z.uuid().nullable(),
  channel: z.enum(CHANNELS),
  topic: z.enum(TICKET_TOPICS),
  status: z.enum(TICKET_STATUSES),
  queue: z.enum(TICKET_QUEUES),
  priority: z.enum(TICKET_PRIORITIES),
  assigneeMembershipId: z.uuid().nullable(),
  flags: z.array(z.enum(TICKET_FLAGS)),
  firstResponseDueAt: instant,
  firstRespondedAt: instant.nullable(),
  overdue: z.boolean(),
  lastMessageAt: instant,
  createdAt: instant,
  /** True in the clinical queue without support:clinical: the ticket exists, its text isn't shown (SUP2). */
  textHidden: z.boolean(),
  patient: z
    .object({
      patientId: z.uuid(),
      displayName: z.string().nullable(),
      verified: z.boolean(),
    })
    .nullable(),
};

export const ticketListReply = z.object({
  tickets: z.array(
    z.object({
      ...ticketSummary,
      preview: z
        .object({
          direction: z.enum(MESSAGE_DIRECTIONS),
          channel: z.enum(CHANNELS),
          subject: z.string().nullable(),
          snippet: z.string(),
          automated: z.boolean(),
          at: instant,
        })
        .nullable(),
    }),
  ),
  nextBefore: instant.nullable(),
});

const messageView = z.object({
  messageId: z.uuid(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  channel: z.enum(CHANNELS),
  status: z.enum(MESSAGE_STATUSES),
  from: z.string().nullable(),
  to: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  automated: z.boolean(),
  authorType: z.enum(ACTOR_TYPES),
  authorId: z.string().nullable(),
  attachmentCount: z.number().int(),
  failureCode: z.string().nullable(),
  createdAt: instant,
  sentAt: instant.nullable(),
});

const commentView = z.object({
  commentId: z.uuid(),
  authorUserId: z.uuid(),
  body: z.string(),
  createdAt: instant,
});

export const ticketReply = z.object({
  ...ticketSummary,
  patientPanel: z
    .object({
      patientId: z.uuid(),
      displayName: z.string(),
      dateOfBirth: z.string(),
      email: z.string().nullable(),
      mobile: z.string().nullable(),
    })
    .nullable(),
  verification: z
    .object({
      method: z.enum(VERIFICATION_METHODS).nullable(),
      at: instant,
      byUserId: z.uuid().nullable(),
    })
    .nullable(),
  messages: z.array(messageView).nullable(),
  comments: z.array(commentView).nullable(),
  reply: z.object({
    allowed: z.boolean(),
    refusal: z.string().nullable(),
    channel: z.enum(['email', 'sms', 'chat']).nullable(),
  }),
});

export const ticketChangeBody = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    queue: z.enum(TICKET_QUEUES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    assigneeMembershipId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Change at least one thing');

export const replyBody = z
  .object({
    body: text(10_000),
    macroId: z.uuid().optional(),
    status: z.enum(['waiting', 'solved']).optional(),
  })
  .strict();
export const callBody = z
  .object({
    direction: z.enum(['inbound', 'outbound']),
    summary: text(5_000),
    phone: z.string().trim().max(32).nullable().optional(),
  })
  .strict();
export const commentBody = z.object({ body: text(5_000) }).strict();
export const commentReply = commentView;

export const flagBody = z
  .object({
    flag: z.enum(['emergency', 'self_harm', 'possible_adverse_event', 'possible_complaint', 'legal', 'person_requested']),
  })
  .strict();
export const flagsReply = z.object({ flags: z.array(z.enum(TICKET_FLAGS)) });

export const patientLinkBody = z.object({ patientId: z.uuid().nullable() }).strict();
export const verifyBody = z.object({ method: z.enum(['date_of_birth', 'call_back']) }).strict();

export const macroView = z.object({
  macroId: z.uuid(),
  name: z.string(),
  body: z.string(),
  status: z.enum(MACRO_STATUSES),
  approvedAt: instant.nullable(),
  updatedAt: instant,
});
export const macroListReply = z.object({ macros: z.array(macroView) });
export const macroBody = z.object({ name: text(120), body: text(10_000) }).strict();
export const macroChangeBody = z
  .object({ name: text(120).optional(), body: text(10_000).optional() })
  .strict()
  .refine((body) => body.name !== undefined || body.body !== undefined, 'Change the name or the wording');
export const archivedReply = z.object({ archived: z.literal(true) });

// The patient app (APP-04).
const patientTopic = z.enum(['care_team', 'orders', 'billing', 'account']);
const patientMessage = z.object({
  messageId: z.uuid(),
  from: z.enum(['you', 'team', 'automatic']),
  body: z.string(),
  createdAt: instant,
});
const patientStatus = z.enum(['open', 'answered', 'closed']);

export const patientTicketListReply = z.object({
  tickets: z.array(
    z.object({
      ticketId: z.uuid(),
      topic: patientTopic,
      status: patientStatus,
      lastMessageAt: instant,
      lastMessage: patientMessage.nullable(),
    }),
  ),
});
export const patientTicketReply = z.object({
  ticketId: z.uuid(),
  topic: patientTopic,
  status: patientStatus,
  createdAt: instant,
  messages: z.array(patientMessage),
});
export const patientTicketBody = z
  .object({
    topic: patientTopic,
    subject: text(200).nullable().optional(),
    body: text(5_000),
  })
  .strict();
export const patientMessageBody = z.object({ body: text(5_000) }).strict();
