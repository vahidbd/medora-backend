import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { listAccounts, listEntries } from './ledger.queries.js';
import { accountParams, accountsReply, entriesQuery, entriesReply } from './ledger.schemas.js';

/**
 * Reading the ledger, for finance (docs/decisions/billing.md BIL6). Nothing
 * here writes: postings come only from the billing services that move money.
 */
export const ledgerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/ledger/accounts',
    {
      config: { access: { permission: 'ledger:read' } },
      schema: { tags: ['ledger'], summary: "The tenant's ledger accounts and their balances", response: { 200: accountsReply } },
    },
    async (request) => ({ accounts: await withTenant(tenantContextOf(request), listAccounts) }),
  );

  app.get(
    '/ledger/accounts/:accountId/entries',
    {
      config: { access: { permission: 'ledger:read' } },
      schema: {
        tags: ['ledger'],
        summary: 'The newest entries on a ledger account, with every line of each',
        params: accountParams,
        querystring: entriesQuery,
        response: { 200: entriesReply },
      },
    },
    async (request) => ({
      entries: await withTenant(tenantContextOf(request), (tx) => listEntries(tx, request.params.accountId, request.query.limit)),
    }),
  );
};
