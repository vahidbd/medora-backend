import { describe, expect, it } from 'vitest';
import { isStopKeyword } from '../../src/modules/support/inbound.service.js';
import { countsAsFirstResponse, firstResponseDue } from '../../src/modules/support/sla.js';
import { triage } from '../../src/modules/support/triage.js';

/** The helpdesk's pure rules (docs/decisions/support.md). No database. */

describe('triage (SUP3)', () => {
  it('sends an emergency to the clinical queue as urgent', () => {
    const checked = triage(null, 'My husband has chest pain and is short of breath');
    expect(checked).toMatchObject({ urgent: true, clinical: true });
    expect(checked.flags).toContain('emergency');
  });

  it('treats words of self-harm as urgent, in the subject too', () => {
    expect(triage('I want to end my life', 'please help')).toMatchObject({ urgent: true, clinical: true, flags: ['self_harm'] });
  });

  it('sends side effects to the clinical queue without making them urgent', () => {
    const checked = triage(null, "I've had a side effect since the last injection");
    expect(checked.clinical).toBe(true);
    expect(checked.urgent).toBe(false);
  });

  it('marks a complaint as only possible, and leaves a plain order question alone', () => {
    expect(triage(null, 'I want to make a complaint about my order').flags).toEqual(['possible_complaint']);
    expect(triage('Order', 'Where is my order? I would like a refund now')).toEqual({ flags: [], clinical: false, urgent: false });
  });

  it('notices someone asking for a person', () => {
    expect(triage(null, 'Can I speak to a real person please').flags).toContain('person_requested');
  });

  it('recognises only a bare opt-out word as STOP', () => {
    expect(isStopKeyword(' Stop ')).toBe(true);
    expect(isStopKeyword('please stop sending me these')).toBe(false);
  });
});

describe('first response (SUP5)', () => {
  const start = new Date('2026-11-21T00:00:00Z');

  it('gives urgent an hour, the clinical queue four and the support queue a day, on the wall clock', () => {
    expect(firstResponseDue(start, 'clinical', 'urgent').toISOString()).toBe('2026-11-21T01:00:00.000Z');
    expect(firstResponseDue(start, 'clinical', 'normal').toISOString()).toBe('2026-11-21T04:00:00.000Z');
    expect(firstResponseDue(start, 'support', 'normal').toISOString()).toBe('2026-11-22T00:00:00.000Z');
  });

  it('never counts an automatic reply, and counts an agent only in the support queue', () => {
    expect(countsAsFirstResponse({ queue: 'clinical', priority: 'urgent', authorType: 'system', automated: true })).toBe(false);
    expect(countsAsFirstResponse({ queue: 'support', priority: 'normal', authorType: 'agent', automated: true })).toBe(true);
    expect(countsAsFirstResponse({ queue: 'clinical', priority: 'normal', authorType: 'agent', automated: true })).toBe(false);
    expect(countsAsFirstResponse({ queue: 'clinical', priority: 'urgent', authorType: 'person', automated: false })).toBe(true);
  });
});
