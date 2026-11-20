import { forEachTenant, type Job } from '../../lib/jobs.js';
import { balanceDrift } from './ledger.queries.js';

/**
 * The nightly check (ADR 0016, docs/decisions/billing.md BIL2): every
 * account's cached balance against the sum of its lines. It reports a
 * difference; it never corrects one. Comparing with Stripe's and eWAY's
 * records joins it once payments land.
 */
export const ledgerBalanceCheck: Job = {
  name: 'ledger-balance-check',
  everySeconds: 24 * 60 * 60,
  run: async (context) => {
    let drifted = 0;
    await forEachTenant(context, async (tx) => {
      for (const drift of await balanceDrift(tx)) {
        drifted += 1;
        context.log.error({ job: context.name, tenantId: tx.context.tenantId, ...drift }, 'ledger balance differs from its lines');
      }
    });
    if (drifted > 0) throw new Error(`${drifted} ledger balances differ from their lines`);
  },
};
