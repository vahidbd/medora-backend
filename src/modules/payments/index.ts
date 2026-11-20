/**
 * Payments: each tenant's own processor accounts and the adapters that talk
 * to the processors (ADRs 0019 and 0037, docs/decisions/billing.md). The
 * module's front door (ADR 0027); billing's later parts add what they need.
 */
export { paymentAccountRoutes } from './payment-accounts.routes.js';
