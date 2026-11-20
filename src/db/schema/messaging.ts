import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { tenants, users } from './platform.js';
import { tickets } from './support.js';
import { ACTOR_TYPES, CHANNELS, MESSAGE_DIRECTIONS, MESSAGE_KINDS, MESSAGE_STATUSES, SENDER_CHANNELS, SENDER_PURPOSES } from './values.js';
import { clinical, operational } from './zones.js';

/**
 * Every message to or from a person on any channel, in or out (PRD CRM-02,
 * docs/decisions/messaging.md CRM1): helpdesk messages, care-team messages
 * and the service messages other modules send. One table and one delivery
 * path (ADR 0027). Clinical zone because the text is often about health.
 * Marketing sends are not here: they live in the marketing zone.
 *
 * A message is a record: nothing edits its text after it is written and
 * nothing deletes it (CRM4, ADR 0028). Only delivery fields change.
 */
export const messages = clinical.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The helpdesk ticket it belongs to, if any. */
    ticketId: uuid('ticket_id'),
    patientId: uuid('patient_id'),
    /** The brand it was sent as, or to. */
    brandId: uuid('brand_id'),
    direction: text('direction').notNull(),
    channel: text('channel').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    /** Email address or E.164 mobile; null for chat and voice. */
    fromAddress: text('from_address'),
    toAddress: text('to_address'),
    subject: text('subject'),
    body: text('body').notNull(),
    /** The template or fixed wording it came from, e.g. `support.safety_reply`. */
    templateKey: text('template_key'),
    /** Sent by a rule or an agent, not typed by a person (SUP-07): the patient sees it labelled. */
    automated: boolean('automated').notNull().default(false),
    authorType: text('author_type').notNull(),
    authorId: uuid('author_id'),
    /** Attachments aren't stored in v1 (CRM4); the count tells staff one was sent. */
    attachmentCount: integer('attachment_count').notNull().default(0),
    providerMessageId: text('provider_message_id'),
    /** A provider's error code, never text from the message. */
    failureCode: text('failure_code'),
    /** Callers' key for "send this once" (ADR 0029). */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When delivery claimed it; the sweep measures a stuck send from here, not from when it was queued. */
    sendingAt: timestamp('sending_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'messages_ticket_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'messages_brand_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patients.tenantId, patients.id],
      name: 'messages_patient_fk',
    }),
    index('messages_ticket_idx').on(table.tenantId, table.ticketId, table.createdAt),
    index('messages_patient_idx').on(table.tenantId, table.patientId),
    index('messages_brand_idx').on(table.tenantId, table.brandId),
    uniqueIndex('messages_idempotency_key').on(table.tenantId, table.idempotencyKey),
    uniqueIndex('messages_provider_key').on(table.tenantId, table.channel, table.providerMessageId),
    check('messages_direction_check', oneOf(table.direction, MESSAGE_DIRECTIONS)),
    check('messages_channel_check', oneOf(table.channel, CHANNELS)),
    check('messages_kind_check', oneOf(table.kind, MESSAGE_KINDS)),
    check('messages_status_check', oneOf(table.status, MESSAGE_STATUSES)),
    check('messages_author_type_check', oneOf(table.authorType, ACTOR_TYPES)),
    check('messages_author_check', sql`(${table.authorType} = 'system') = (${table.authorId} is null)`),
    check(
      'messages_status_direction_check',
      sql`(${table.direction} = 'inbound' and ${table.status} in ('received', 'logged')) or (${table.direction} = 'outbound' and ${table.status} in ('queued', 'sending', 'sent', 'delivered', 'failed', 'logged'))`,
    ),
    // Written without IN, so the allowed-values test reads only messages_channel_check for channel.
    check('messages_address_check', sql`(${table.channel} <> 'email' and ${table.channel} <> 'sms') or (${table.fromAddress} is not null and ${table.toAddress} is not null)`),
  ],
);

/**
 * A brand's own address on a channel (docs/decisions/messaging.md CRM5):
 * the email address or SMS number its messages come from and its replies go
 * to. Service and marketing addresses are kept apart, so a STOP to marketing
 * never blocks a dose reminder or the safety reply.
 */
export const senders = operational.table(
  'senders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    brandId: uuid('brand_id').notNull(),
    channel: text('channel').notNull(),
    purpose: text('purpose').notNull(),
    /** Lower-case email address, or an E.164 number. */
    address: text('address').notNull(),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'senders_brand_fk',
    }),
    uniqueIndex('senders_brand_channel_purpose_key').on(table.tenantId, table.brandId, table.channel, table.purpose),
    uniqueIndex('senders_address_key').on(table.tenantId, table.channel, table.address),
    index('senders_updated_by_idx').on(table.updatedByUserId),
    check('senders_channel_check', oneOf(table.channel, SENDER_CHANNELS)),
    check('senders_purpose_check', oneOf(table.purpose, SENDER_PURPOSES)),
  ],
);
