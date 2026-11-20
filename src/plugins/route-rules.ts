import type { FastifyInstance, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission } from '../lib/permissions.js';

/**
 * What every route must say about itself, checked as it registers, so the
 * app can't start with a route that forgot (ADRs 0008, 0012, 0014, 0016, 0030):
 *
 * - `access`: 'public', 'signed-in', 'member' (signed in to the tenant it
 *   names, with a second factor, needing no permission of its own),
 *   'patient' or 'patient-sign-in' (patients, src/plugins/patient-auth.ts),
 *   or the permission it needs;
 * - a response schema for its success replies;
 * - if it changes data: the audit actions it writes, the events it emits and
 *   the agent tool that does the same (or, for each, why there is none).
 */
export type Access = 'public' | 'signed-in' | 'member' | 'patient' | 'patient-sign-in' | { permission: Permission };

/** A list of names, or the reason there are none. */
export type Declared = readonly string[] | { none: string };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    audit?: Declared;
    events?: Declared;
    agentTool?: string | { none: string };
  }
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function declared(value: Declared | string | { none: string } | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if ('none' in value) return value.none.trim().length > 0;
  return value.length > 0;
}

export function routeProblems(route: Pick<RouteOptions, 'method' | 'url' | 'config' | 'schema'>): string[] {
  const methods = [route.method].flat();
  if ((route.schema as { hide?: boolean } | undefined)?.hide) return [];
  const config = (route.config ?? {}) as { access?: Access; audit?: Declared; events?: Declared; agentTool?: string | { none: string } };
  const problems: string[] = [];
  if (!config.access) problems.push("declares no access ('public', 'signed-in', 'member' or { permission })");
  const response = (route.schema as { response?: Record<string, unknown> } | undefined)?.response ?? {};
  if (!Object.keys(response).some((status) => /^2\d\d$/.test(status))) problems.push('has no response schema for its success reply');
  if (methods.some((method) => !READS.has(method))) {
    if (!declared(config.audit)) problems.push('changes data but declares no audit actions (or { none: reason })');
    if (!declared(config.events)) problems.push('changes data but declares no events (or { none: reason })');
    if (!declared(config.agentTool)) problems.push('changes data but names no agent tool (or { none: reason })');
  }
  return problems.map((problem) => `${methods.join(',')} ${route.url} ${problem}`);
}

export const routeRulesPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onRoute', (route) => {
    const problems = routeProblems(route);
    if (problems.length > 0) throw new Error(problems.join('\n'));
  });
});
