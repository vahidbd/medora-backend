/**
 * The ledger: every money movement as balanced, append-only entries in
 * integer cents (ADR 0016, docs/decisions/billing.md). The module's front
 * door (ADR 0027): billing posts through postEntry and reverseEntry inside
 * its own transaction; finance reads through the routes.
 */
export type { AccountRef } from './ledger.accounts.js';
export { ledgerBalanceCheck } from './ledger.check.js';
export { ledgerBalance } from './ledger.queries.js';
export { ledgerRoutes } from './ledger.routes.js';
export { type EntryInput, type LineInput, type PostedEntry, entryIdForKey, postEntry, reverseEntry } from './ledger.service.js';
