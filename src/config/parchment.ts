import { z } from 'zod';

/**
 * Each tenant's Parchment organisation (docs/decisions/prescribing.md RX4).
 * Medora is one Parchment partner per environment; each tenant is one
 * Parchment organisation with its own secret, an integration user that
 * creates patients and reads scripts, and the secret its webhooks are signed
 * with. Kept in the deploy environment's secrets as JSON until tenant
 * settings can hold secrets encrypted; a tenant with no entry has
 * prescribing switched off.
 */
const organization = z
  .object({
    tenantId: z.uuid(),
    organizationId: z.string().min(1),
    organizationSecret: z.string().min(16),
    userId: z.string().min(1),
    webhookSecret: z.string().min(16),
  })
  .strict();

export type ParchmentOrganization = z.infer<typeof organization>;

const organizations = z.array(organization).refine((list) => new Set(list.map((o) => o.tenantId)).size === list.length, {
  message: 'lists a tenant twice',
});

export interface ParchmentSettings {
  PARCHMENT_MODE: 'fake' | 'live';
  PARCHMENT_API_URL?: string | undefined;
  PARCHMENT_PORTAL_URL?: string | undefined;
  PARCHMENT_PARTNER_ID?: string | undefined;
  PARCHMENT_PARTNER_SECRET?: string | undefined;
  PARCHMENT_ORGANIZATIONS?: string | undefined;
}

/** The organisations in PARCHMENT_ORGANIZATIONS. Throws a message that names no secret. */
export function parseParchmentOrganizations(raw: string | undefined): ParchmentOrganization[] {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('PARCHMENT_ORGANIZATIONS is not valid JSON');
  }
  const parsed = organizations.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'the list'} ${issue.message}`).join('; ');
    throw new Error(`PARCHMENT_ORGANIZATIONS is not a list of { tenantId, organizationId, organizationSecret, userId, webhookSecret }: ${where}`);
  }
  return parsed.data;
}

export function parchmentProblems(config: ParchmentSettings): string[] {
  const problems: string[] = [];
  try {
    parseParchmentOrganizations(config.PARCHMENT_ORGANIZATIONS);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (config.PARCHMENT_MODE === 'live') {
    for (const name of ['PARCHMENT_API_URL', 'PARCHMENT_PORTAL_URL', 'PARCHMENT_PARTNER_ID', 'PARCHMENT_PARTNER_SECRET'] as const) {
      if (!config[name]) problems.push(`${name} is required when PARCHMENT_MODE=live`);
    }
  }
  return problems;
}
