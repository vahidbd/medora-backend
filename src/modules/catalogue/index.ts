/**
 * The catalogue and blocked items (docs/decisions/catalogue.md CAT1 to
 * CAT6): a tenant's products and Medora's block rules. The module's front
 * door (ADR 0027). Orders, billing and prescribing call
 * assertProductSuppliable (or read `blocked` from getOrderableProduct)
 * every time a product is used.
 */
export { catalogueRoutes } from './catalogue.routes.js';
export type { BlockRule, Product, Product as OrderableProduct, ProductBlock } from './catalogue.schemas.js';
export { assertProductSuppliable, getProduct as getOrderableProduct, listProducts } from './catalogue.service.js';
