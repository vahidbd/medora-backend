/**
 * Billing: prices and subscriptions now; invoices as they arrive
 * (docs/decisions/billing.md). The module's front door (ADR 0027).
 */
export { priceRoutes } from './prices.routes.js';
export { subscriptionRoutes } from './subscriptions.routes.js';
/** Checkout starts a subscription in the same transaction as the patient's first order (BIL18). */
export { startSubscription, type Subscription } from './subscriptions.service.js';
