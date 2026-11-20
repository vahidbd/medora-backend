import type { FastifyInstance, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import type { Permission } from '../lib/permissions.js';
import type { Access } from './route-rules.js';

/**
 * The agent tool catalogue (ADR 0012, docs/decisions/agents.md AGT2). A route
 * whose config names `agentTool: '<name>'` is a tool: its summary is the
 * tool's description and its own params, querystring and body schemas are
 * the tool's input. An agent runs it by calling the route, so the route's
 * permission check, tenancy, compliance gates and audit apply to the agent
 * exactly as to a person. Collected as routes register, before the app starts.
 */
export type JsonSchema = Record<string, unknown>;

export interface AgentToolRoute {
  name: string;
  method: string;
  /** The route's pattern, e.g. `/v1/staff/:membershipId`. */
  url: string;
  description: string;
  permission: Permission;
  changesData: boolean;
  /** One object schema: path, query and body fields side by side. */
  inputSchema: JsonSchema & { properties: Record<string, JsonSchema>; required: string[] };
  /** Which part of the request each input field belongs to. */
  parts: Record<string, 'path' | 'query' | 'body'>;
}

declare module 'fastify' {
  interface FastifyInstance {
    agentTools: Map<string, AgentToolRoute>;
  }
}

const NAME = /^[a-z][a-z0-9_]{2,63}$/;
const READS = new Set(['GET', 'HEAD']);

function objectSchema(schema: unknown, what: string, route: string): { properties: Record<string, JsonSchema>; required: string[] } {
  if (schema === undefined) return { properties: {}, required: [] };
  if (!(schema instanceof z.ZodType)) throw new Error(`${route}: the ${what} schema of an agent tool must be a Zod schema`);
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  if (json['type'] !== 'object') throw new Error(`${route}: the ${what} schema of an agent tool must be an object`);
  return {
    properties: (json['properties'] as Record<string, JsonSchema> | undefined) ?? {},
    required: (json['required'] as string[] | undefined) ?? [],
  };
}

export function toolFromRoute(route: Pick<RouteOptions, 'method' | 'url' | 'config' | 'schema'>): AgentToolRoute | null {
  const config = (route.config ?? {}) as { agentTool?: unknown; access?: Access };
  if (typeof config.agentTool !== 'string') return null;
  const method = [route.method].flat()[0] ?? 'GET';
  // Fastify adds a HEAD route beside every GET; the GET is the tool.
  if (method === 'HEAD') return null;
  const label = `${method} ${route.url}`;
  const name = config.agentTool;
  if (!NAME.test(name)) throw new Error(`${label}: agent tool name "${name}" must be snake_case, 3 to 64 characters`);
  const access = config.access;
  if (!access || typeof access === 'string') throw new Error(`${label}: an agent tool must be a route that needs a permission`);
  const schema = (route.schema ?? {}) as { summary?: string; params?: unknown; querystring?: unknown; body?: unknown };
  if (!schema.summary) throw new Error(`${label}: an agent tool needs a summary, which is its description`);

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const parts: AgentToolRoute['parts'] = {};
  for (const [part, value] of [['path', schema.params], ['query', schema.querystring], ['body', schema.body]] as const) {
    const object = objectSchema(value, part, label);
    for (const [key, property] of Object.entries(object.properties)) {
      if (key in parts) throw new Error(`${label}: agent tool input field "${key}" appears in more than one part of the request`);
      parts[key] = part;
      properties[key] = property;
    }
    required.push(...object.required);
  }
  return {
    name,
    method,
    url: route.url,
    description: schema.summary,
    permission: access.permission,
    changesData: !READS.has(method),
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    parts,
  };
}

export const agentToolsPlugin = fp(async (app: FastifyInstance) => {
  app.decorate('agentTools', new Map<string, AgentToolRoute>());
  app.addHook('onRoute', (route) => {
    const tool = toolFromRoute(route);
    if (!tool) return;
    if (app.agentTools.has(tool.name)) throw new Error(`Two routes name the agent tool "${tool.name}"`);
    app.agentTools.set(tool.name, tool);
  });
});

/** A tool's input as a request: path fields fill the pattern, the rest go to the query or the body. */
export function requestFor(tool: AgentToolRoute, input: Record<string, unknown>): { url: string; query: Record<string, string>; body?: Record<string, unknown> } {
  let url = tool.url;
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const part = tool.parts[key];
    if (part === 'path') url = url.replace(`:${key}`, encodeURIComponent(String(value)));
    else if (part === 'query') query[key] = String(value);
    else if (part === 'body') body[key] = value;
  }
  return { url, query, ...(tool.method === 'GET' || tool.method === 'HEAD' ? {} : { body }) };
}
