/**
 * Support: the helpdesk and the patient app's Messages (PRD section 13,
 * docs/decisions/support.md). The module's front door (ADR 0027).
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { patientTicketRoutes } from './patient-tickets.routes.js';
import { supportRoutes as staffSupportRoutes } from './support.routes.js';

export const supportRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(staffSupportRoutes);
  await app.register(patientTicketRoutes);
};

export { replyRefusal, type Viewer } from './access.js';
export { markOverdue, overdueJob, registerSupportWebhooks } from './channels.js';
export { clearFlag, flagTicket, type SettableFlag } from './flags.service.js';
export { isStopKeyword, receiveMessage, type InboundMessage } from './inbound.service.js';
export { openPatientTicket } from './patient-tickets.service.js';
export { addComment, logCall, replyToTicket } from './replies.service.js';
export { getTicket, listTickets, updateTicket } from './tickets.service.js';
export { triage } from './triage.js';
