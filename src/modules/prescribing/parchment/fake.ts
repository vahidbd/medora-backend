import { randomUUID } from 'node:crypto';
import { ParchmentFailure, type ParchmentClient, type ParchmentPatientDetails, type ParchmentUser } from './types.js';

/**
 * An in-memory Parchment for development and tests (PARCHMENT_MODE=fake;
 * production refuses it). Every tenant shares it. Tests add users to it, read
 * what was sent, and make the next call fail.
 */
export class FakeParchment implements ParchmentClient {
  /** The secret the fake's webhooks are signed with, in development and tests only. */
  readonly webhookSecret = 'fake-parchment-webhook-secret-for-tests';
  readonly patients = new Map<string, ParchmentPatientDetails>();
  readonly users: ParchmentUser[] = [];
  readonly calls: string[] = [];
  private failure: ParchmentFailure | null = null;

  reset(): void {
    this.patients.clear();
    this.users.length = 0;
    this.calls.length = 0;
    this.failure = null;
  }

  /** The next call answers with this failure. */
  failNext(status: number, fields: string[] = []): void {
    this.failure = new ParchmentFailure(status, fields);
  }

  /** Parchment's id for a patient the fake holds, by our patient id. */
  parchmentIdOf(partnerPatientId: string): string | undefined {
    return [...this.patients.entries()].find(([, details]) => details.partnerPatientId === partnerPatientId)?.[0];
  }

  private take(call: string): void {
    this.calls.push(call);
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure;
  }

  async createPatient(details: ParchmentPatientDetails) {
    this.take('createPatient');
    const parchmentPatientId = `pat_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.patients.set(parchmentPatientId, details);
    return { parchmentPatientId };
  }

  async updatePatient(parchmentPatientId: string, details: ParchmentPatientDetails) {
    this.take('updatePatient');
    if (!this.patients.has(parchmentPatientId)) throw new ParchmentFailure(404);
    this.patients.set(parchmentPatientId, details);
  }

  async listUsers() {
    this.take('listUsers');
    return [...this.users];
  }
}

export const fakeParchment = new FakeParchment();
