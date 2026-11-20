import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { routeProblems } from '../../src/plugins/route-rules.js';

const response = { 200: z.object({ ok: z.boolean() }) };

describe('what every route must declare', () => {
  it('passes a read with access and a response schema', () => {
    expect(routeProblems({ method: 'GET', url: '/x', config: { access: 'signed-in' }, schema: { response } })).toEqual([]);
  });

  it('needs access and a success schema', () => {
    const problems = routeProblems({ method: 'GET', url: '/x', config: {}, schema: {} });
    expect(problems.join('\n')).toMatch(/declares no access/);
    expect(problems.join('\n')).toMatch(/no response schema/);
  });

  it('needs audit, events and an agent tool (or reasons) on a change', () => {
    const problems = routeProblems({ method: 'POST', url: '/x', config: { access: 'signed-in' }, schema: { response } }).join('\n');
    expect(problems).toMatch(/no audit actions/);
    expect(problems).toMatch(/no events/);
    expect(problems).toMatch(/no agent tool/);
    expect(
      routeProblems({
        method: 'POST',
        url: '/x',
        config: { access: 'signed-in', audit: ['x.created'], events: { none: 'nothing listens yet' }, agentTool: { none: 'people only' } },
        schema: { response },
      }),
    ).toEqual([]);
  });

  it('does not accept an empty reason', () => {
    const problems = routeProblems({
      method: 'DELETE',
      url: '/x',
      config: { access: 'signed-in', audit: { none: ' ' }, events: [], agentTool: '' },
      schema: { response },
    });
    expect(problems).toHaveLength(3);
  });
});
