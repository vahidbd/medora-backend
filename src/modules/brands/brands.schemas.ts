import { z } from 'zod';
import { AU_STATES, BRAND_STATUSES, TIME_ZONES } from '../../db/schema/values.js';

/** Request and reply shapes for tenant set-up (docs/decisions/admin.md ADM14 to ADM20). */

const atLeastOne = (body: object) => Object.keys(body).length > 0;
const iso = z.iso.datetime();

// Tenant settings (ADM20).

export const tenantSettings = z.object({ tenantId: z.uuid(), name: z.string(), timeZone: z.enum(TIME_ZONES) });
export type TenantSettings = z.infer<typeof tenantSettings>;

const tenantName = z.string().trim().min(1).max(120);
export const tenantSettingsChange = z
  .object({ name: tenantName.optional(), timeZone: z.enum(TIME_ZONES).optional() })
  .strict()
  .refine(atLeastOne, { message: 'Send a name or a time zone' });
export type TenantSettingsChange = z.infer<typeof tenantSettingsChange>;

// Companies (ADM19).

export const company = z.object({
  companyId: z.uuid(),
  legalName: z.string(),
  tradingName: z.string().nullable(),
  /** Eleven digits, no spaces. */
  abn: z.string(),
  state: z.enum(AU_STATES),
  /** Brands that belong to it; a company with any can't be deleted. */
  brandCount: z.number().int(),
  updatedAt: iso,
});
export type Company = z.infer<typeof company>;
export const companiesReply = z.object({ companies: z.array(company) });

const legalName = z.string().trim().min(1).max(200);
const tradingName = z.string().trim().max(200).nullable();
/** Spaces are allowed as people type them, and taken out before the checksum. */
const abn = z.string().max(20);

export const companyInput = z
  .object({ legalName, tradingName: tradingName.optional(), abn, state: z.enum(AU_STATES) })
  .strict();
export type CompanyInput = z.infer<typeof companyInput>;

export const companyChange = z
  .object({ legalName: legalName.optional(), tradingName: tradingName.optional(), abn: abn.optional(), state: z.enum(AU_STATES).optional() })
  .strict()
  .refine(atLeastOne, { message: 'Send at least one field to change' });
export type CompanyChange = z.infer<typeof companyChange>;

export const companyParams = z.object({ companyId: z.uuid() });
export const companyDeletedReply = z.object({ companyId: z.uuid() });

// Brands and their hosts (ADM15 to ADM17).

export const brandDomain = z.object({
  domainId: z.uuid(),
  host: z.string(),
  /** When platform staff checked it; a host does nothing until then. */
  verifiedAt: iso.nullable(),
});
export type BrandDomain = z.infer<typeof brandDomain>;

export const brand = z.object({
  brandId: z.uuid(),
  companyId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(BRAND_STATUSES),
  supportEmail: z.string().nullable(),
  supportPhone: z.string().nullable(),
  /** #rrggbb that white or near-black text reaches 4.5:1 on. */
  primaryColour: z.string().nullable(),
  logoUrl: z.string().nullable(),
  domains: z.array(brandDomain),
  updatedAt: iso,
});
export type Brand = z.infer<typeof brand>;
export const brandsReply = z.object({ brands: z.array(brand) });

const brandName = z.string().trim().min(1).max(80);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lower-case letters, numbers and single hyphens')
  .min(2)
  .max(40);
const supportEmail = z.email().max(254).nullable();
const supportPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, 'Use digits, spaces and an optional leading +')
  .nullable();
const primaryColour = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Use a colour like #1f6feb')
  .nullable();
const logoUrl = z.url({ protocol: /^https$/ }).max(500).nullable();

const brandFields = {
  companyId: z.uuid(),
  name: brandName,
  supportEmail: supportEmail.optional(),
  supportPhone: supportPhone.optional(),
  primaryColour: primaryColour.optional(),
  logoUrl: logoUrl.optional(),
};

/** A new brand starts as a draft. Its slug is part of its public address and never changes. */
export const brandInput = z.object({ ...brandFields, slug }).strict();
export type BrandInput = z.infer<typeof brandInput>;

export const brandChange = z
  .object({
    companyId: brandFields.companyId.optional(),
    name: brandFields.name.optional(),
    supportEmail: brandFields.supportEmail,
    supportPhone: brandFields.supportPhone,
    primaryColour: brandFields.primaryColour,
    logoUrl: brandFields.logoUrl,
  })
  .strict()
  .refine(atLeastOne, { message: 'Send at least one field to change' });
export type BrandChange = z.infer<typeof brandChange>;

/** Going live, pausing (no new patients) and resuming (ADM16). A brand never goes back to draft. */
export const brandStatusChange = z.object({ status: z.enum(['live', 'paused']) }).strict();

export const brandParams = z.object({ brandId: z.uuid() });
export const domainInput = z.object({ host: z.string().max(300) }).strict();
export const domainParams = z.object({ brandId: z.uuid(), domainId: z.uuid() });
export const domainDeletedReply = z.object({ domainId: z.uuid() });

// The onboarding checklist (ADM18).

export const ONBOARDING_ITEMS = ['company', 'live_brand', 'medical_director', 'prescriber'] as const;
export type OnboardingItem = (typeof ONBOARDING_ITEMS)[number];

export const onboardingReply = z.object({
  /** Every item done: the tenant may take new patients. */
  ready: z.boolean(),
  items: z.array(z.object({ key: z.enum(ONBOARDING_ITEMS), done: z.boolean() })),
});
export type Onboarding = z.infer<typeof onboardingReply>;

// Platform staff (ADM14, ADM15).

export const platformTenant = z.object({
  tenantId: z.uuid(),
  name: z.string(),
  timeZone: z.enum(TIME_ZONES),
  createdAt: iso,
  /** Whether an owner has accepted their invitation. */
  ownerJoined: z.boolean(),
  brands: z.number().int(),
  liveBrands: z.number().int(),
});
export type PlatformTenant = z.infer<typeof platformTenant>;
export const platformTenantsReply = z.object({ tenants: z.array(platformTenant) });

export const tenantInput = z
  .object({
    name: tenantName,
    timeZone: z.enum(TIME_ZONES),
    ownerEmail: z.email().max(254),
    ownerName: z.string().trim().max(120).optional(),
  })
  .strict();
export type TenantInput = z.infer<typeof tenantInput>;

const invitationEmail = z.enum(['sent', 'failed', 'not_configured']);
export const tenantCreatedReply = z.object({ tenant: platformTenant, email: invitationEmail });
export const ownerInvitationReply = z.object({ tenantId: z.uuid(), email: invitationEmail });
export const platformTenantParams = z.object({ tenantId: z.uuid() });

export const platformDomain = z.object({
  domainId: z.uuid(),
  tenantId: z.uuid(),
  tenantName: z.string(),
  brandId: z.uuid(),
  brandName: z.string(),
  host: z.string(),
  createdAt: iso,
  verifiedAt: iso.nullable(),
});
export type PlatformDomain = z.infer<typeof platformDomain>;
export const platformDomainsReply = z.object({ domains: z.array(platformDomain) });
export const platformDomainsQuery = z.object({ waiting: z.enum(['true', 'false']).default('true') });
export const platformDomainParams = z.object({ domainId: z.uuid() });
export const domainVerifiedReply = z.object({ domainId: z.uuid(), host: z.string() });

// Public pages (ADM16).

export const publicBrand = z.object({
  brandId: z.uuid(),
  tenantId: z.uuid(),
  name: z.string(),
  status: z.enum(['live', 'paused']),
  logoUrl: z.string().nullable(),
  primaryColour: z.string().nullable(),
  supportEmail: z.string().nullable(),
  supportPhone: z.string().nullable(),
  /** The tenant's, for dates on its pages (ADR 0017). */
  timeZone: z.enum(TIME_ZONES),
});
export type PublicBrand = z.infer<typeof publicBrand>;
export const hostParams = z.object({ host: z.string().max(300) });
