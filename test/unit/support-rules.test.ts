import { describe, expect, it } from 'vitest';
import { AGENT_FORBIDDEN_PERMISSIONS, PERMISSION_ZONES, ROLE_PERMISSIONS, usablePermissions, type Permission } from '../../src/lib/permissions.js';
import { replyRefusal, type Viewer } from '../../src/modules/support/access.js';
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

describe('who may reply (SUP2, SUP12)', () => {
  const viewer = (type: 'person' | 'agent', permissions: Permission[]): Viewer => ({
    actor: type === 'person' ? { type, userId: 'u' } : { type, agentId: 'a' },
    permissions: new Set(permissions),
    membershipId: null,
  });

  it('refuses the clinical queue to anyone without support:clinical', () => {
    expect(replyRefusal(viewer('person', ['support:read', 'support:reply']), { queue: 'clinical', flags: [] })).toBe('This ticket is in the clinical queue');
    expect(replyRefusal(viewer('person', ['support:read', 'support:reply', 'support:clinical']), { queue: 'clinical', flags: [] })).toBeNull();
  });

  it('keeps agents off the clinical queue and off anything a person must answer', () => {
    const agent = viewer('agent', ['support:read', 'support:reply', 'support:clinical']);
    expect(replyRefusal(agent, { queue: 'clinical', flags: [] })).toBe('Agents never reply in the clinical queue');
    expect(replyRefusal(agent, { queue: 'support', flags: ['possible_complaint'] })).toBe('This ticket is for staff to answer');
    expect(replyRefusal(agent, { queue: 'support', flags: [] })).toBeNull();
  });
});

describe('helpdesk permissions (SUP11)', () => {
  it('opens the support queue without break-glass, and the clinical queue only for a clinical role', () => {
    expect(PERMISSION_ZONES['support:read']).toBe('operational');
    expect(PERMISSION_ZONES['support:clinical']).toBe('clinical');
    expect(usablePermissions({ role: 'support' }, false).has('support:read')).toBe(true);
    expect(usablePermissions({ role: 'owner' }, false).has('support:clinical')).toBe(false);
    expect(usablePermissions({ role: 'clinician' }, false).has('support:clinical')).toBe(true);
  });

  it('gives support no clinical key, and finance nothing of the helpdesk', () => {
    expect(ROLE_PERMISSIONS.support.filter((key) => PERMISSION_ZONES[key] === 'clinical')).toEqual([]);
    expect(ROLE_PERMISSIONS.finance.filter((key) => key.startsWith('support:'))).toEqual([]);
  });

  it('lets admin give the support role, since it holds every key of it, but never the clinical queue', () => {
    expect(ROLE_PERMISSIONS.support.every((key) => ROLE_PERMISSIONS.admin.includes(key))).toBe(true);
    expect(ROLE_PERMISSIONS.admin).not.toContain('support:clinical');
  });

  it.each(['support:clinical', 'support:manage', 'messaging:manage'] as const)('never lets an agent use %s', (key) => {
    expect(AGENT_FORBIDDEN_PERMISSIONS.has(key)).toBe(true);
  });
});
