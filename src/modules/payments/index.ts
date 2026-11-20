/**
 * Payments: each tenant's own processor accounts, patients' saved cards, and
 * the adapters that talk to the processors (ADRs 0019 and 0160,
 * docs/decisions/billing.md). The module's front door (ADR 0027).
 */
export { paymentAccountRoutes } from './payment-accounts.routes.js';
export { type ChargeableMethod, type PaymentMethodToSave, chargeableMethod, methodLabels, savePaymentMethod } from './payment-methods.service.js';
export { type ChargeResult, ProcessorRefusedError, type RefundResult } from './processor.js';
export { paymentProcessor } from './processors.js';
