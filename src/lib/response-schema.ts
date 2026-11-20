import type { FastifyBaseLogger } from 'fastify';
import { ResponseSerializationError } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { reportError } from './error-tracking.js';

/**
 * Response schemas (ADR 0014). A route's response schema says what it may
 * send: keys it doesn't declare are left out, so a column added to a table
 * stays private until someone adds it to the schema on purpose.
 *
 * When a reply doesn't match its schema:
 * - in tests it throws, so the test fails and the schema gets fixed;
 * - in development, staging and production it is never a 500 (the work may
 *   already be committed and a 500 invites a retry): the route and the
 *   mismatched paths (never values) are logged and reported, and the body is
 *   cut to the declared keys.
 *
 * In tests a reply also fails when it drops a key nobody meant to drop, or
 * carries a key that looks like a credential.
 */

/** Keys left out of replies on purpose. */
export const DROPPED_ON_PURPOSE: ReadonlySet<string> = new Set(['clerkUserId']);

/** A key no reply may carry. */
export const CREDENTIAL_KEY = /password|secret|token|hash/i;

type ZodSchema = z.ZodType;
type Compiler = (route: { schema: unknown; method: string; url: string; httpStatus?: string }) => (data: unknown) => string;

export function createResponseSerializer(options: { strict: boolean; log: FastifyBaseLogger }): Compiler {
  return ({ schema, method, url, httpStatus }) => {
    const zod = resolveSchema(schema);
    let json: JsonSchema | null = null;
    return (data) => {
      const result = zod.safeParse(data);
      if (result.success) {
        if (options.strict) checkStrictly(data, result.data, method, url);
        return JSON.stringify(result.data);
      }
      const issues = result.error.issues.map((issue) => ({ path: pathOf(issue.path), code: issue.code }));
      if (options.strict) throw new ResponseSerializationError(method, url, { cause: result.error });
      options.log.error({ route: `${method} ${url}`, status: httpStatus, issues }, 'reply did not match its schema');
      reportError(new Error(`Reply did not match its schema: ${issues.map((i) => i.path).join(', ')}`), { tags: { route: `${method} ${url}` } });
      json ??= z.toJSONSchema(zod, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
      return JSON.stringify(cutToSchema(json, data));
    };
  };
}

function resolveSchema(schema: unknown): ZodSchema {
  if (schema instanceof z.ZodType) return schema;
  throw new Error('Response schemas are Zod schemas');
}

/** `items.[].email`: array positions are left out, so nothing from the body is logged. */
function pathOf(path: PropertyKey[]): string {
  return path.map((part) => (typeof part === 'number' ? '[]' : String(part))).join('.');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
}

/** The value with only the keys the schema declares, values as they are. */
export function cutToSchema(schema: JsonSchema, value: unknown, root: JsonSchema = schema): unknown {
  if (value === null || value === undefined) return value;
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const target = root.$defs?.[name];
    return target ? cutToSchema(target, value, root) : value;
  }
  const options = (schema.anyOf ?? schema.oneOf)?.filter((option) => option.type !== 'null');
  if (options) return options.length === 1 && options[0] ? cutToSchema(options[0], value, root) : value;
  if (schema.properties && isPlainObject(value)) {
    const out: Record<string, unknown> = schema.additionalProperties === false ? {} : { ...value };
    for (const [key, inner] of Object.entries(schema.properties)) {
      if (key in value) out[key] = cutToSchema(inner, value[key], root);
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (schema.prefixItems) return value.map((item, i) => (schema.prefixItems?.[i] ? cutToSchema(schema.prefixItems[i], item, root) : item));
    if (schema.items) return value.map((item) => cutToSchema(schema.items as JsonSchema, item, root));
  }
  return value;
}

/** Tests only: nothing dropped that isn't dropped on purpose, and no credential-like key. */
function checkStrictly(input: unknown, output: unknown, method: string, url: string): void {
  const dropped: string[] = [];
  const credentials: string[] = [];
  walk(JSON.parse(JSON.stringify(input) ?? 'null'), JSON.parse(JSON.stringify(output) ?? 'null'), [], dropped, credentials);
  if (dropped.length === 0 && credentials.length === 0) return;
  const problems = [
    ...(dropped.length ? [`drops ${[...new Set(dropped)].join(', ')} (add them to the schema, or to DROPPED_ON_PURPOSE with a reason)`] : []),
    ...(credentials.length ? [`sends credential-like ${[...new Set(credentials)].join(', ')}`] : []),
  ];
  const message = `${method} ${url}: the reply ${problems.join('; ')}`;
  throw new ResponseSerializationError(method, url, { cause: new z.ZodError([{ code: 'custom', path: [], message, input }]) });
}

function walk(before: unknown, after: unknown, path: string[], dropped: string[], credentials: string[]): void {
  if (Array.isArray(before)) {
    if (Array.isArray(after)) before.forEach((item, i) => walk(item, after[i], [...path, '[]'], dropped, credentials));
    return;
  }
  if (!isPlainObject(before)) return;
  const kept = isPlainObject(after) ? after : {};
  for (const [key, value] of Object.entries(before)) {
    const at = [...path, key];
    if (!(key in kept)) {
      if (!DROPPED_ON_PURPOSE.has(key)) dropped.push(at.join('.'));
      continue;
    }
    if (CREDENTIAL_KEY.test(key)) credentials.push(at.join('.'));
    walk(value, kept[key], at, dropped, credentials);
  }
}
