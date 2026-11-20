/**
 * Support: the helpdesk (PRD section 13, docs/decisions/support.md). The
 * module's front door (ADR 0027).
 */
export { markOverdue, overdueJob, registerSupportWebhooks } from './channels.js';
export { isStopKeyword, receiveMessage, type InboundMessage } from './inbound.service.js';
export { triage } from './triage.js';
