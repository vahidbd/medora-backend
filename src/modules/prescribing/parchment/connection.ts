import { env } from '../../../config/env.js';
import { parseParchmentOrganizations, type ParchmentOrganization } from '../../../config/parchment.js';
import { BusinessRuleError } from '../../../lib/errors.js';
import { liveParchment } from './client.js';
import { fakeParchment } from './fake.js';
import type { ParchmentClient } from './types.js';

/**
 * Which Parchment a tenant uses (RX4). In fake mode every tenant shares the
 * in-memory fake; live, a tenant without an organisation in
 * PARCHMENT_ORGANIZATIONS has prescribing switched off.
 */
const organizations: ParchmentOrganization[] = parseParchmentOrganizations(env.PARCHMENT_ORGANIZATIONS);

function organizationOf(tenantId: string): ParchmentOrganization | undefined {
  return organizations.find((org) => org.tenantId === tenantId);
}

export interface ParchmentConnection {
  client: ParchmentClient;
  /** Parchment's organisation id, which every webhook names. */
  organizationId: string;
  /** Where a prescriber opens a patient: the portal's patient page. */
  portalUrl(parchmentPatientId: string): string;
}

const FAKE_PORTAL = 'https://parchment.invalid/dashboard/patients';

/** The tenant's Parchment, or null when prescribing isn't set up for it. */
export function parchmentConnection(tenantId: string): ParchmentConnection | null {
  if (env.PARCHMENT_MODE === 'fake') {
    return { client: fakeParchment, organizationId: organizationOf(tenantId)?.organizationId ?? `fake-${tenantId}`, portalUrl: (id) => `${env.PARCHMENT_PORTAL_URL ?? FAKE_PORTAL}/${encodeURIComponent(id)}` };
  }
  const org = organizationOf(tenantId);
  if (!org || !env.PARCHMENT_API_URL || !env.PARCHMENT_PORTAL_URL || !env.PARCHMENT_PARTNER_ID || !env.PARCHMENT_PARTNER_SECRET) return null;
  const portal = env.PARCHMENT_PORTAL_URL.replace(/\/$/, '');
  return {
    client: liveParchment({ apiUrl: env.PARCHMENT_API_URL, partnerId: env.PARCHMENT_PARTNER_ID, partnerSecret: env.PARCHMENT_PARTNER_SECRET }, org),
    organizationId: org.organizationId,
    portalUrl: (id) => `${portal}/${encodeURIComponent(id)}`,
  };
}

export function requireParchment(tenantId: string): ParchmentConnection {
  const connection = parchmentConnection(tenantId);
  if (!connection) throw new BusinessRuleError("Prescribing isn't set up for this clinic yet. Ask an owner to connect Parchment.", 'prescribing_not_set_up');
  return connection;
}
