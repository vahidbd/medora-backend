import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import type { IhiRecordStatus, IhiStatus, Sex } from '../../db/schema/values.js';

/**
 * Finding a patient's Individual Healthcare Identifier (IDN-04,
 * docs/decisions/patients.md IDN19). The tenant is the healthcare provider,
 * so a real lookup runs under the tenant's own HI Service organisation
 * (its HPI-O and certificate), with Medora as its contracted service
 * provider: the interface takes the tenant, and the real client finds that
 * tenant's credentials. It needs a NASH certificate and conformance first;
 * until then development, tests and staging use the fake.
 */

export interface IhiSearch {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: Sex;
  medicare: { number: string; irn: string | null } | null;
}

export type IhiResult =
  | { outcome: 'found'; ihi: string; status: IhiStatus; recordStatus: IhiRecordStatus }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable' };

export interface HiService {
  findIhi(tenant: { tenantId: string }, search: IhiSearch): Promise<IhiResult>;
}

/** The Luhn check digit that ends every IHI. */
function luhnDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * The made-up HI Service. It finds a made-up IHI (800360 and digits from the
 * details, with a valid check digit) for everyone, except a given name of
 * "Nobody" (not found) or "Offline" (the service is down).
 */
export const fakeHiService: HiService = {
  async findIhi(tenant, search) {
    if (search.givenName === 'Offline') return { outcome: 'unavailable' };
    if (search.givenName === 'Nobody') return { outcome: 'not_found' };
    const seed = createHash('sha256').update(`${tenant.tenantId}|${search.familyName}|${search.dateOfBirth}`).digest();
    const body = `800360${[...seed.subarray(0, 9)].map((byte) => byte % 10).join('')}`;
    return { outcome: 'found', ihi: body + luhnDigit(body), status: 'active', recordStatus: 'verified' };
  },
};

/** The configured HI Service, or null when lookups are off. */
export function hiService(): HiService | null {
  return env.HI_SERVICE === 'fake' ? fakeHiService : null;
}
