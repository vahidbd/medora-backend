import { and, eq } from 'drizzle-orm';
import { patientSignIns, patients, tenants } from './schema/index.js';
import { withTenant } from './tenant.js';

/**
 * Who a verified patient sign-in is inside one tenant (ADR 0035,
 * docs/decisions/patients.md IDN2 and IDN3). Runs inside the tenant, so
 * row-level security decides what exists; no cross-tenant function is needed,
 * because the request names its tenant before anyone is looked up.
 */
export interface PatientSignInState {
  /** False when the tenant doesn't exist. */
  tenantFound: boolean;
  /** The patient record linked to this sign-in in this tenant, if any. */
  patientId: string | null;
  /** Whether this sign-in session has confirmed the patient's date of birth. */
  confirmed: boolean;
}

export async function findPatientSignIn(
  tenantId: string,
  sign: { clerkUserId: string; sessionId: string },
  requestId: string,
): Promise<PatientSignInState> {
  return withTenant({ tenantId, actor: { type: 'system' }, requestId }, async (tx) => {
    const [tenant] = await tx.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) return { tenantFound: false, patientId: null, confirmed: false };
    const [patient] = await tx.db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), eq(patients.clerkUserId, sign.clerkUserId)));
    if (!patient) return { tenantFound: true, patientId: null, confirmed: false };
    const [session] = await tx.db
      .select({ id: patientSignIns.id })
      .from(patientSignIns)
      .where(and(eq(patientSignIns.tenantId, tenantId), eq(patientSignIns.patientId, patient.id), eq(patientSignIns.sessionId, sign.sessionId)));
    return { tenantFound: true, patientId: patient.id, confirmed: Boolean(session) };
  });
}
