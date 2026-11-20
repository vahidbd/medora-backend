import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withTenant } from '../../db/tenant.js';
import { tenantContextOf } from '../../plugins/auth.js';
import { invoice, invoiceParams, invoicesQuery, invoicesReply } from './invoices.schemas.js';
import { getInvoice, listInvoices } from './invoices.service.js';

/** Staff read invoices (BIL27). Invoices are issued by checkout and the renewal job, never through a route. */
const access = { permission: 'invoices:read' } as const;
const tags = ['billing'];

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/invoices',
    { config: { access }, schema: { tags, summary: 'Issued invoices, newest first, for a patient or a subscription', querystring: invoicesQuery, response: { 200: invoicesReply } } },
    async (request) => ({ invoices: await withTenant(tenantContextOf(request), (tx) => listInvoices(tx, request.query)) }),
  );

  app.get(
    '/invoices/:invoiceId',
    { config: { access }, schema: { tags, summary: 'One invoice and its lines', params: invoiceParams, response: { 200: invoice } } },
    async (request) => withTenant(tenantContextOf(request), (tx) => getInvoice(tx, request.params.invoiceId)),
  );
};
