import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { helpCentreRoutes } from './help-centre.routes.js';
import { publicHelpCentreRoutes } from './public.routes.js';

/**
 * Each brand's help centre (PRD SUP-04, SUP-06, docs/decisions/support.md
 * SUP14 to SUP19): articles written and approved by staff, the public pages,
 * and the support agent's search. The module's front door (ADR 0027).
 */
export const helpCentreModuleRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(helpCentreRoutes);
  await app.register(publicHelpCentreRoutes);
};
