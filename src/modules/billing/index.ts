/**
 * Billing: prices, subscriptions and invoices (docs/decisions/billing.md).
 * The module's front door (ADR 0027).
 */
export { priceRoutes } from './prices.routes.js';
export { subscriptionRoutes } from './subscriptions.routes.js';
export { invoiceRoutes } from './invoices.routes.js';
/** Checkout starts a subscription in the same transaction as the patient's first order (BIL18). */
export { startSubscription, type Subscription } from './subscriptions.service.js';
/** The renewal job, given who clears a period (BIL24), and what orders reads to place renewal orders ahead (BIL26). */
export { type Clearance, type ClearanceRequest, type ClearanceSource, nothingClearsYet, renewalsJob, type UpcomingRenewal, upcomingRenewals } from './renewals.js';
