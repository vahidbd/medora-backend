import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { brandRoutes } from './brands.routes.js';
import { platformRoutes } from './platform.routes.js';
import { tenantRoutes } from './tenant.routes.js';

/**
 * A tenant's set-up (docs/decisions/admin.md ADM14 to ADM20): its settings,
 * companies, brands and their domains, the onboarding checklist, and
 * platform staff's routes. The module's front door (ADR 0027).
 */
export const tenantSetupRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(tenantRoutes);
  await app.register(brandRoutes);
  await app.register(platformRoutes);
};

export type { Brand, BrandDomain, PublicBrand } from './brands.schemas.js';
export { assertAcceptingPatients, getBrand, listBrands } from './brands.service.js';
export { resolvePublicBrand, type ResolvedBrand } from './platform.service.js';
