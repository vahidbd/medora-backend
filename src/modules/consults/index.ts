/**
 * Consults: real-time phone and video appointments, their evidence and the
 * consult gate (docs/decisions/consults.md). The module's front door (ADR 0027).
 */
import type { FastifyPluginAsync } from 'fastify';
import { videoRoutes } from './video.routes.js';

export const consultRoutes: FastifyPluginAsync = async (app) => {
  await app.register(videoRoutes);
};

export { CONSULT_GATE_FLOOR, findQualifyingConsult, listQualifyingConsults, type QualifyingConsult } from './gate.service.js';
export { consultRoomName, participantIdentity, type Participant } from './video-room.js';
