/**
 * Messaging: the one way Medora writes, sends and receives a message on
 * email, SMS, chat or a logged call (ADR 0027, docs/decisions/messaging.md).
 * The module's front door.
 */
export { deliverMessage, messageDelivery, registerDeliveryWebhooks, sweepUnconfirmed, unconfirmedSweep } from './delivery.js';
export { fakeEmail } from './email.js';
export { messagingRoutes } from './messaging.routes.js';
export { countTemplateSince, findMessage, latestMessages, messagesOfTickets, queueMessage, recordMessage, type MessageRow, type QueueInput } from './messages.service.js';
export { senderAddress, senderByAddress } from './senders.service.js';
