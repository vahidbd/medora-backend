/**
 * Support: the helpdesk (PRD section 13, docs/decisions/support.md). The
 * module's front door (ADR 0027).
 */
export { replyRefusal, type Viewer } from './access.js';
export { markOverdue, overdueJob, registerSupportWebhooks } from './channels.js';
export { clearFlag, flagTicket, type SettableFlag } from './flags.service.js';
export { isStopKeyword, receiveMessage, type InboundMessage } from './inbound.service.js';
export { addComment, logCall, replyToTicket } from './replies.service.js';
export { supportRoutes } from './support.routes.js';
export { getTicket, listTickets, updateTicket } from './tickets.service.js';
export { triage } from './triage.js';
