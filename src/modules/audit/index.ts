/**
 * Reading the tenant's audit log (docs/decisions/admin.md ADM25, ADM26):
 * search and export for those holding audit:read. Writing entries stays in
 * src/lib/audit.ts. The module's front door (ADR 0027).
 */
export { auditRoutes } from './audit.routes.js';
